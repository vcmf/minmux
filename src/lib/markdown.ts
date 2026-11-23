// Markdown → HTML for a file tab's Preview (docs/design/MARKDOWN.md): markdown-it with task
// lists, GitHub's math (KaTeX, loaded only when a document looks like it has math), our raw-HTML
// allowlist (lib/markdown-html), links limited to http(s), mailto and relative ones, GitHub's
// heading anchors and each top-level block's source line. Runs in lib/markdown.worker.
import MarkdownIt from "markdown-it"
import type { MarkdownIt as Md, StateCore, StateInline, Token } from "markdown-it"
import { tasklist } from "@mdit/plugin-tasklist"
import { escapeHtml, HIGHLIGHT_MAX } from "./file-preview"
import { syncHighlighter } from "./highlighter"
import { cleanHtml } from "./markdown-html"
import { safeLink } from "./markdown-links"

export { safeLink }

/** How to render: `repo` (owner/name) for a PR's body or comment, GitHub's comment rules. */
export interface RenderOptions {
  repo?: string
}

/** One top-level block: its HTML, and the source line it starts on (1-based; 0: none). */
export interface Block {
  html: string
  line: number
}

// Blocks, not one string: a Preview re-rendered while an agent writes replaces only the blocks
// whose HTML changed (lib/markdown-patch). A block's line is kept apart from its HTML, so text
// added above doesn't make every block below look changed.
/** A rendered document: its blocks, and whether they have math (KaTeX's CSS then). */
export interface Rendered {
  blocks: Block[]
  math: boolean
}

// `$$`, $`…`$, a ```math fence, or a `$…$` pair on one line that could be math. A false hit only
// costs loading KaTeX; a miss shows that formula as text.
const MATH_HINT = /\$\$|\$`|^\s*(?:```|~~~)\s*math\b|\$[^\s$][^$\n]*\$/m

/** Whether `text` may hold math (KaTeX loads for it). */
export const mayHaveMath = (text: string) => MATH_HINT.test(text)

const count = (s: string, re: RegExp) => s.match(re)?.length ?? 0

/** A heading's anchor as GitHub makes it: lowercase, punctuation gone, spaces to `-`. */
export function slugOf(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, "")
    .replace(/ /g, "-")
}

// Fenced code is highlighted once highlight.js has loaded (only for a document with a fence).
let highlight: (code: string, lang: string) => string = (code) => escapeHtml(code)
let highlighting: Promise<void> | null = null
const loadHighlight = () =>
  (highlighting ??= syncHighlighter().then(
    (fn) => void (highlight = fn),
    () => void (highlighting = null), // plain this time; the next document tries again
  ))

// `data-anchor`, never `id`: a heading can't clobber the page's names.
/** Heading anchors, as GitHub makes them (a repeat numbered). */
function marks(state: StateCore): void {
  const seen = new Map<string, number>()
  state.tokens.forEach((t, i) => {
    if (t.type !== "heading_open") return
    const words = (state.tokens[i + 1]?.children ?? [])
      .filter((c) => c.type === "text" || c.type === "code_inline")
      .map((c) => c.content)
      .join("")
    const base = slugOf(words)
    const n = seen.get(base) ?? 0
    seen.set(base, n + 1)
    t.attrSet("data-anchor", n ? `${base}-${n}` : base)
  })
}

// `#12` and `owner/name#12`, as GitHub links them in a comment (not in code, not in a link). Each
// goes to its issues URL (GitHub sends a PR's on to the PR), marked `data-ref` for the dialog.
const REF = /(?<![\w/#&.:-])(?:([\w.-]+\/[\w.-]+))?#(\d+)\b/g

/** A PR body's references, as links. */
function refs(state: StateCore): void {
  const repo = (state.env as RenderOptions | undefined)?.repo
  if (!repo) return
  const text = (s: string) => {
    const t = new state.Token("text", "", 0)
    t.content = s
    return t
  }
  for (const block of state.tokens) {
    if (block.type !== "inline" || !block.children) continue
    let inLink = 0
    const out: Token[] = []
    for (const t of block.children) {
      if (t.type === "link_open") inLink++
      else if (t.type === "link_close") inLink--
      else if (t.type === "html_inline" && /^<(code|kbd)\b/i.test(t.content))
        inLink++ // code
      else if (t.type === "html_inline" && /^<\/(code|kbd)\b/i.test(t.content)) inLink--
      if (t.type !== "text" || inLink > 0 || !t.content.includes("#")) {
        out.push(t)
        continue
      }
      let at = 0
      for (const m of t.content.matchAll(REF)) {
        if (m.index > at) out.push(text(t.content.slice(at, m.index)))
        const r = m[1] ?? repo
        const open = new state.Token("link_open", "a", 1)
        open.attrs = [
          ["href", `https://github.com/${r}/issues/${m[2]}`],
          ["data-ref", `${r}#${m[2]}`],
        ]
        out.push(open, text(m[0]), new state.Token("link_close", "a", -1))
        at = m.index + m[0].length
      }
      if (at < t.content.length) out.push(at ? text(t.content.slice(at)) : t)
    }
    block.children = out
  }
}

/** GitHub's $`…`$ inline math (ahead of the `$…$` rule, which would keep the backticks). */
function backtickMath(state: StateInline, silent: boolean): boolean {
  const { src, pos } = state
  if (src.charCodeAt(pos) !== 0x24 || src.charCodeAt(pos + 1) !== 0x60) return false
  const end = src.indexOf("`$", pos + 2)
  if (end < 0) return false
  if (!silent) {
    const t = state.push("math_inline", "math", 0)
    t.content = src.slice(pos + 2, end)
    t.markup = "$`"
  }
  state.pos = end + 2
  return true
}

function base(): Md {
  const md = new MarkdownIt({ html: true, linkify: true })
  md.validateLink = safeLink
  md.use(tasklist)
  const raw = (tokens: Token[], i: number) => cleanHtml(tokens[i]!.content)
  md.renderer.rules.html_block = raw
  md.renderer.rules.html_inline = raw
  md.renderer.rules.fence = (tokens, i, _opts, _env, self) => {
    const t = tokens[i]!
    const lang = t.info.trim().split(/\s+/)[0] ?? ""
    const code =
      lang && t.content.length <= HIGHLIGHT_MAX ? highlight(t.content, lang) : escapeHtml(t.content)
    const cls = lang ? ` class="language-${escapeHtml(lang)}"` : ""
    return `<pre${self.renderAttrs(t)}><code${cls}>${code}</code></pre>\n`
  }
  // An image stays a link to it until images load (step 4 of the design): no remote request.
  // Inside a link (a README badge) it is that link's text: anchors can't nest.
  md.renderer.rules.image = (tokens, i, opts, env, self) => {
    const t = tokens[i]!
    const src = String(t.attrGet("src") ?? "")
    const alt = escapeHtml(self.renderInlineAsText(t.children ?? [], opts, env) || src)
    let depth = 0
    for (let k = 0; k < i; k++)
      depth += tokens[k]!.type === "link_open" ? 1 : tokens[k]!.type === "link_close" ? -1 : 0
    const data = `data-src="${escapeHtml(src)}"` // lib/markdown-images loads it
    if (depth > 0) return `<span class="md-img" ${data}>${alt}</span>`
    return `<a class="md-img" href="${escapeHtml(src)}" ${data}>${alt}</a>`
  }
  md.core.ruler.push("minmux_refs", refs)
  md.core.ruler.push("minmux_marks", marks)
  return md
}

let plain: Md | null = null
let withMath: Promise<Md> | null = null

/** The math instance: KaTeX without `\href` and friends (`trust: false`), errors in red. */
function mathMd(): Promise<Md> {
  withMath ??= import("@mdit/plugin-katex").then(({ katex }) => {
    const md = base() // its fence rule first: `mathFence` wraps it
    md.use(katex, {
      mathFence: true,
      trust: false,
      throwOnError: false,
      logger: () => "ignore" as const,
    })
    md.inline.ruler.before("math_inline_dollar", "math_backtick", backtickMath)
    return md
  })
  withMath.catch(() => (withMath = null)) // a failed chunk load is tried again next time
  return withMath
}

/** `text` rendered (KaTeX and highlight.js load the first time a document needs them). */
export async function renderMarkdown(text: string, opts: RenderOptions = {}): Promise<Rendered> {
  if (/^\s*(?:```|~~~)/m.test(text)) await loadHighlight()
  let md = (plain ??= base())
  if (mayHaveMath(text)) md = await mathMd().catch(() => md)
  md.set({ breaks: !!opts.repo }) // GitHub's comments: a newline is a line break
  const env = { repo: opts.repo }
  const tokens = md.parse(text, env)
  const blocks: Block[] = []
  let math = false
  // Each top-level token run (its open to its matching close, or a lone block) is one block. A raw
  // <details> left open (GitHub's fold: <details><summary>…, markdown, then </details>) takes in
  // the blocks up to its close, so it folds them as on GitHub (a block is parsed on its own).
  let open = 0 // raw <details> still open, in the block being built
  for (let i = 0, start = 0, depth = 0; i < tokens.length; i++) {
    depth += tokens[i]!.nesting
    if (depth !== 0) continue
    const html = md.renderer.render(tokens.slice(start, i + 1), md.options, env)
    if (html) {
      math ||= html.includes('class="katex')
      const into = open > 0 ? blocks[blocks.length - 1] : undefined
      if (into) into.html += html
      else blocks.push({ html, line: (tokens[start]!.map?.[0] ?? -1) + 1 })
      // Our own tags only (cleanHtml writes them; a user's text is escaped): exact counts.
      open = Math.max(0, open + count(html, /<details[ >]/g) - count(html, /<\/details>/g))
    }
    start = i + 1
  }
  return { blocks, math }
}
