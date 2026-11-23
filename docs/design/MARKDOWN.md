# Markdown rendering

Status: **agreed**, step 1 next · Scope: `src/lib/markdown*` (new: renderer, worker, client,
html allowlist), `src/components/file-view.tsx` (a Preview view), `src/components/markdown-view.tsx`
(new), `src/components/pr-detail-view.tsx` (bodies and comments), `src/lib/folder-entries.ts`
(`view`), `src/App.css`

Follows WORKDIR_OBJECTS.md, which left markdown out: "Until it lands, a markdown file previews as
source."

## Problem

Agents write markdown all day: plans, `CLAUDE.md`, design notes, READMEs, PR bodies. minmux shows
all of it as source. A `.md` file tab is highlighted text with line numbers, and a PR body or
comment is plain text with clickable links and fenced code as `<pre>` (`pr-detail-view.tsx`,
`bodyBlocks`). Tables, lists, headings and task lists are hard to read that way, and math written
as `$…$` can't be read at all.

## What we measured

Versions as of 2026-11-23: markdown-it 15.0.3, KaTeX 0.19.1, @mdit/plugin-katex 1.2.1,
@mdit/plugin-tasklist 1.3.1, marked 18.2.1, Temml 0.14.0. Sizes come from an esbuild minified ESM
bundle; times are medians on this Mac under Node 22.

| bundle                                | minified | gzip   |
| ------------------------------------- | -------- | ------ |
| markdown-it + tasklist                | 101 KB   | 42 KB  |
| markdown-it + tasklist + KaTeX plugin | 374 KB   | 119 KB |
| marked                                | 51 KB    | 15 KB  |
| KaTeX alone                           | 268 KB   | 77 KB  |
| Temml alone                           | 212 KB   | 59 KB  |
| KaTeX fonts (20 woff2)                | 296 KB   |        |

| work                                             | time    |
| ------------------------------------------------ | ------- |
| load markdown-it                                 | 5.9 ms  |
| load the KaTeX plugin on top                     | 16.4 ms |
| first render with math (KaTeX cold)              | 32 ms   |
| `docs/ARCHITECTURE.md`, 31 KB: markdown-it       | 3.3 ms  |
| same file: marked                                | 2.9 ms  |
| every `docs/**/*.md` joined, 412 KB: markdown-it | 28 ms   |
| same text: marked                                | 26 ms   |
| 7 KB with 100 formulas: markdown-it + KaTeX      | 9.0 ms  |

Parsing speed doesn't separate the two parsers. What costs time is loading KaTeX the first time
and inserting a large document's DOM, so the design is about when things load and how much DOM
goes in at once.

## Decisions

### Engine

**markdown-it** with `html` handled by our allowlist (below), `linkify: true`, and two plugins:
`@mdit/plugin-tasklist` and `@mdit/plugin-katex`. Tables and strikethrough are built in.

Headings get ids the way GitHub makes them (lowercase, spaces to `-`, punctuation dropped, `-1`
for a repeat), written by a small core rule. Our docs link to sections all the time
(`GOTCHAS.md#fonts`), so a link with a fragment scrolls to its heading, in the same view or in the
file tab it opens.

Math follows GitHub, since PR bodies are written for GitHub:

- `$…$` inline and `$$…$$` display, from the plugin. Its rules keep prices and shell variables as
  text. Tested: `$5, or $10`, `export PATH=$PATH:$HOME/bin`, `set $HOME and $PATH` and
  `$MINMUX_PROFILE, then $HOME` all render as plain text.
- ``$`…`$``, GitHub's form for math that would clash with markdown. The plugin reads the
  backticks as part of the TeX today, so we add a small inline rule.
- ` ```math ` fences, rendered as display math by a fence rule. The plugin doesn't do these.

KaTeX runs with `trust: false` and `throwOnError: false`. A bad formula shows in red, and `\href`,
`\url` and `\htmlId` render as errors instead of links or ids (tested).

### Where it runs

Rendering runs in a Web Worker, `markdown.worker.ts`, the way `highlight.worker.ts` runs
highlight.js for file tabs. A `markdown-client.ts` posts the text and gets HTML back. Where there's
no Worker (tests), it renders on the main thread, like `highlight-client.ts`.

Nothing loads at startup. The worker chunk loads the first time a markdown view shows. KaTeX loads
inside the worker the first time a document contains a math delimiter (a cheap regex check), so a
README without math never pays the 16 ms load or the 32 ms first render. KaTeX's stylesheet and
fonts are added to the page once, when the first HTML with math arrives.

Fenced code is highlighted in the same worker through `highlighter.ts`, so code in a markdown file
looks the same as in a file tab.

### Safety

The renderer page holds `window.minmux`, which can spawn processes. HTML injected into the page is
code execution, so the output must not carry markup we didn't choose. Markdown files and PR bodies
both come from other people.

1. **HTML in the source goes through an allowlist.** markdown-it hands raw HTML to us as
   `html_block` and `html_inline` tokens. Our render rule keeps a tag only when it is on the list
   and has no attributes, except `open` on `<details>`: `details`, `summary`, `br`, `sub`, `sup`,
   `kbd`, `b`, `i`, `em`, `strong`, `code`, `ins`, `del`, `hr`, `p`. HTML comments are dropped.
   Everything else is escaped and shows as text. The rule works on tokens, so it runs in the worker
   without a DOM.
2. **Links are checked twice.** markdown-it's `validateLink` refuses `javascript:`, `vbscript:`,
   `file:` and `data:`, which then stay text (tested). Clicks go through our handler: `http(s)` and
   `mailto` open in the browser via `ipc.openExternal`, a relative path opens as a file tab in the
   same pane (the WORKDIR_OBJECTS rule), and `#heading` scrolls within the view.
3. **KaTeX output** is trusted with the settings above.
4. **A test corpus** pins all of it: the cases above plus attribute tricks (`<details open
onclick=…>`), entity-encoded schemes, nested and unclosed tags, and `<img>`, `<iframe>`,
   `<style>` and `<svg>` with event handlers.

### Images

- **Relative images in a file tab** (`![](docs/shot.png)`) are read through the fs worker, which
  already reads files and WSL paths for file tabs. Each becomes a blob URL, capped at 5 MB, and is
  read when it scrolls into view.
- **Remote images** don't load on their own. They can be tracking pixels, and GitHub attachments
  in private repos need a login we don't send. One shows as a placeholder with its alt text, and a
  click loads it. A setting `markdown.remoteImages: "click" | "always"` turns that off.

### In a file tab

- A markdown file (`.md`, `.markdown`) gets **Preview | Source**, next to
  **Diff** when git has a diff for it. A file tab opens on Preview. The choice is kept per entry in
  `FileEntry.view`.
- Opening at a line (a `path:42` click) shows Preview scrolled to the block holding line 42.
  markdown-it gives each block its source lines (`token.map`), and the worker writes them as
  `data-line` on every top-level block. Switching between Preview and Source keeps the same lines
  in view, through the same map.
- A file an agent is writing re-renders as it changes, at the rate file tabs already re-read
  (`RELOAD_MS`). The view stays anchored on the top block's `data-line`, so the text being read stays put
  when blocks above it grow.
- Big documents: top-level blocks get `content-visibility: auto`, so blocks off screen skip
  layout. Above 1 MB the tab shows Source with a note. The fs worker already caps what a file tab
  reads at about 2 MB.

### In the PR dialog

PR bodies and comments render with the same worker and allowlist, replacing `bodyBlocks` and
`Text`. Two inline rules keep what the dialog does today: a bare `#123` links to that PR (with its
title when the dialog knows it), and links open through `ipc.openExternal`. GitHub's own HTML
(`bodyHTML`) is not used (see "Challenges").

### Look

The view uses the theme tokens, so it follows every theme family in dark and light. Code blocks
use the file tab's highlight colours. Headings, tables and quotes follow GitHub's spacing, in the
UI font with code in the terminal font.

### Performance

The renderer stays off the terminal hot path: parsing and math run in a worker, chunks load only
when a markdown view shows, and a re-render happens at most once per `RELOAD_MS`, for a view that
is on screen. Each render result goes in with one `innerHTML` write. The `MINMUX_PERF=1` harness
gets a case with a markdown tab re-rendering beside a busy terminal.

## Challenges

**We could skip rendering, since "Open in editor" exists.** Reading a plan an agent just wrote, in
the pane next to it, is the loop minmux is built around. Opening an editor for each plan breaks
that loop, and the editor doesn't follow the file as the agent rewrites it. Source stays one click
away.

**marked is smaller (15 KB against 42 KB gzip) and about 10% faster.** That doesn't decide it.
marked has no safe mode, so HTML would need DOMPurify, which needs a DOM and so can't run in the
worker. It also doesn't give token source lines, which the line-keeping above depends on. 27 KB is
small for a chunk that loads only on demand.

**Temml (59 KB, no fonts) could replace KaTeX (77 KB plus 296 KB of fonts).** Temml writes MathML,
and Chromium draws it with the OS math font. macOS and Windows ship one, while Linux depends on
the distro, so a formula can look different per machine. KaTeX looks the same everywhere, and its
fonts load from disk. Temml stays the fallback if bundle size ever matters more.

**For PRs, GitHub's `bodyHTML` would match github.com exactly.** It is arbitrary HTML from the
network, though, and would need a full DOM sanitizer. GitHub sends math as `<math-renderer>` with
raw TeX, so we would render it anyway. Images in it point at attachments that need a login. And we
would maintain two renderers. Rejected for now. Comments may be worth another look, since they use
more GitHub syntax (suggestions, mentions).

**A sandboxed iframe would isolate the output completely.** An iframe without `allow-scripts`
can't run anything, whatever we miss. It makes theming, scroll keeping, link handling and focus
harder, and every view would carry its own document. The allowlist with its test corpus is smaller
and checkable. A Content-Security-Policy for the whole renderer (`script-src 'self'` plus a hash
for the pre-paint script in `index.html`) adds a second layer for every surface, this one
included, and belongs in its own PR.

**The allowlist will drop HTML that people use.** `<img width=…>`, `<p align="center">` and
`<picture>` are common at the top of READMEs. They will show as text, which is ugly but safe. Each
can be added later with its attributes checked.

**Mermaid.** GitHub renders ` ```mermaid ` blocks, and agents write them. Mermaid is large and runs
its own layout. Not in this design: those blocks show as code.

**Find (⌘F) only searches terminals today.** A rendered view is plain DOM, so it can be searched,
but that's a change to the find bar for every file tab and is left out of this design.

## Steps

1. The renderer (worker, client, allowlist, math rules, heading anchors, tests) and Preview in
   file tabs.
2. A Content-Security-Policy for the renderer, in its own PR: `script-src 'self'` plus the hash of
   the pre-paint script in `index.html`, with a test that the hash matches the script.
3. PR bodies and comments.
4. Images: relative ones through the fs worker, and remote ones on click.

## Settled in discussion

- A markdown file tab opens on **Preview**; Source is one click away.
- Remote images are **click-to-load** by default.
- **Heading anchors** are in step 1. Footnotes stay out (`[^1]` reads fine as text), and
  `:emoji:` shortcodes wait for step 3, if PR comments show they are common (the table is about
  50 KB).
- The **CSP lands before step 3**, the first step that renders text written by other people.

## Not in scope

- Editing markdown, or a live split of source and preview.
- Mermaid and other diagram fences.
- Footnotes.
- Markdown in the terminal itself.
- Find in file tabs.
