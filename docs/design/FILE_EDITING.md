# File editing

Status: **agreed**, step 1 next (#242, #243, #244 on `epic/file-editing`) · Scope: `src/components/file-view.tsx` (an Edit mode),
`src/components/file-editor.tsx` (new), `src/lib/editor-*` (new: save cleanup, indentation, line
endings, highlight style, keymap), `src/lib/file-store.ts` (editor state), `src/lib/close-confirm.ts`,
`src/store.ts` (peeks, closes), `src/settings/schema.ts`, `electron/read-file.ts`,
`electron/fs-worker*.ts` + `electron/main.ts` (`fs:write-file`, unload and quit guards),
`electron/quit-plan.ts`, `src/App.css`

Follows WORKDIR_OBJECTS.md and MARKDOWN.md, which both left editing out ("Editing files; staging or
committing", "Editing markdown").

## Problem

A file tab shows a file and follows it while an agent rewrites it. Changing one line of it (a typo
in a plan, a value in a config, a sentence in `CLAUDE.md`) means "Open in editor", which starts
another app and leaves the pane. For small edits that round trip costs more than the edit.

We want a plain code editor inside the file tab: no WYSIWYG, no language server. It should feel like
a normal editor: indentation that follows the code, Tab and Shift-Tab, and a clean file on save. It
must add no latency to anything else, terminals first, and it must never lose what someone typed or
overwrite what an agent wrote.

## What we measured

CodeMirror 6 as of 2026-11-27: `@codemirror/view` 6.44.2, `state` 6.7.6, `commands` 6.11.2,
`language` 6.13.1, `search` 6.7.3, `language-data` 6.5.2. Sizes come from an esbuild minified ESM
bundle with code splitting. Times are medians on this Mac under Node 22, parser only (no DOM).

| bundle                                                       | minified         | gzip   |
| ------------------------------------------------------------ | ---------------- | ------ |
| core: view, state, commands, language, search, our keymap    | 316 KB           | 102 KB |
| `language-data` index (names, extensions, lazy loaders)      | 16 KB            |        |
| one language, loaded on first use: Python / JS+TS / Markdown | 10 / 50 / 230 KB |        |

Markdown is the large one because it pulls in HTML, CSS and JS for embedded code.

| work                                                          | time          |
| ------------------------------------------------------------- | ------------- |
| full parse, `src/store.ts` (59 KB, TS)                        | 38 ms         |
| full parse, the same ×10 (591 KB)                             | 239 ms        |
| full parse, `docs/ARCHITECTURE.md` (31 KB)                    | 6.6 ms        |
| full parse, the same ×30 (933 KB)                             | 80 ms         |
| one keystroke (edit + incremental re-parse), any of the above | 0.7 to 1.7 ms |

In the view, CodeMirror parses the visible part first and the rest in slices on idle time, so the
full-parse numbers never run as one block. A keystroke's parse costs the same in a 59 KB file and a
600 KB one. The DOM update per key isn't in these numbers; step 2 measures it in the app.

Monaco (VS Code's editor) is about 5 MB with its own workers, and a `<textarea>` with a highlighted
layer under it can't handle undo, IME, long lines or large files well. Neither was measured further
(see Challenges).

## Decisions

### Engine and loading

**CodeMirror 6**, in a chunk of its own that loads the first time a file tab enters Edit. Startup,
terminals and read-only file tabs load none of it. A language loads the first time a file of that
kind is edited, through `@codemirror/language-data` (by file name and extension). A file with no
grammar edits as plain text.

The read-only file tab stays as it is: highlight.js in a worker, only the lines in view rendered. It
is still the cheaper view for logs and large files, and it's what a tab shows until someone edits.

The renderer's CSP already allows what CodeMirror does at runtime: `style-src 'self'
'unsafe-inline'` covers the `<style>` elements and inline styles it adds, and lazy chunks load under
`script-src 'self'` as the markdown and highlight chunks do.

### Entering and leaving Edit

- A text file tab gets an **Edit** button next to Preview | Source | Diff. Edit swaps the view for
  the editor on the same file, at the same top line (a Preview maps its top block to a line as it
  does for Source), with the cursor on the line at the top of the view or the line a `path:42`
  click opened.
- **Done** goes back to the view the tab came from (Preview for markdown). With unsaved changes it
  asks first (Save, Discard, Cancel).
- Edit is offered for text files the read flagged as editable (below), at most `FILE_READ_CAP`
  (2 MB). A WSL file edits through the distro share it was read from. A deleted file, a binary, an
  image and an SSH pane's file have no Edit. A file mid-write can fail the editable check for one
  read; the button follows the last read.
- **A peek becomes a kept entry** when it enters Edit (`keepEntry`), and `openFile` never replaces
  an entry that is in Edit. A peek is the folder's single-click tab, which the next click replaces
  and forgets without asking.
- `openFile` on an entry in Edit moves the cursor to the line it names. A request for Diff leaves
  Edit only when nothing is unsaved; otherwise Edit stays.
- Two panes showing the same file are two entries with two buffers. Each saves against its own base
  (below), so the second save of conflicting text is caught like an agent's write.

### Editor state

- Each entry in Edit keeps its CodeMirror `EditorState` (text, selection, undo history) in the file
  store, outside Zustand. Only the active surface is mounted, so a surface or tab switch unmounts
  the view; the state comes back with its undo history and selection when it's shown again.
- The editor keeps its own **base**: the text it was loaded from (or last saved, or reloaded) and
  that text's hash. The file tab's follow reads keep replacing the store's `data` and `stamp`, and
  they never move the base. Only load, save, Reload and a follow while clean (step 3) do.
- The store publishes an entry's **dirty transitions** only (clean → dirty and back), never per
  keystroke: `files.publish` calls every listener.
- `FILES_KEPT` evicts only entries with nothing unsaved.
- The Edit flag and unsaved text are not persisted. `layout.json` and the workspace file are
  unchanged, so older builds read them as before.

### Saving

- **⌘S** (Ctrl+S elsewhere) saves while the editor has focus. There's no autosave.
- Main writes through a new `fs:write-file(path, text, baseHash, wsl)`, run in a **save worker**:
  a utility process of its own, started on the first save. A read stuck on a dead mount retires the
  files browser's worker, and must never kill a save running beside it. The worker reads the
  file's current bytes and compares their hash with `baseHash`. It writes only when they match;
  otherwise it answers `changed`, and the editor asks **Overwrite** or **Reload**. A stamp can't
  decide this: coarse mtimes on shares and FAT make a fresh save look changed for 2.5 s, and a
  same-size write within one mtime tick looks unchanged. Hashing at most 2 MB in the worker is
  cheap.
- After a write, the worker answers the new stamp. The editor moves its base, and the file store
  takes the saved text and stamp as its `data`, so the watcher's next read is `same`.
- It writes **in place**: open `r+`, write, then `ftruncate` to the new length. Truncating first
  would leave a window where the file reads empty. A rename from a temp file would replace a
  symlink with a file, break hard links, and drop the owner, mode and extended attributes. A crash
  in the middle of a write can leave the file mixed; editors that write in place accept the same.
- **A write is never re-sent.** A write left behind on a retired worker stays there and its answer
  counts; the worker isn't killed under it. A write that hangs itself (`HUNG_MS`, 30 s, for at
  most 2 MB) answers `unknown` and its worker is killed. A failure after the first byte is written,
  or at close (where NFS reports late errors), is `unknown` too. On `unknown` the editor re-reads
  the file and compares it with the text it tried to save, keeping that text either way.
- **Saves of one file run one at a time**, queued in main by path, and in the worker by inode (a
  symlink or another case of the same name). A save that may still land holds its file until its
  process is gone: later saves of that file fail at once with "an earlier save is stuck", and a
  process stuck in a dead mount that never exits holds it for the session. Other files save as
  usual. A known gap: the hold is by path, so a stuck save under one name doesn't hold
  another name of the same file (a symlink); the worker that could say it's one file is the stuck
  one. Another: the save worker runs four file operations at once, so four saves
  hanging on a dead mount within `HUNG_MS` can make a fifth, healthy one time out and hold its
  file for the session (an error, nothing written wrong). Accepted: it takes several hung saves at
  once.
- The WSL share loop tries the next share form only when a form has no file or won't open it, and
  answers `missing` only when no form had the file.
- Main checks the request: an absolute path, an existing regular file (a symlink to one is written
  through), text within `FILE_READ_CAP`. Creating files is out of scope. The renderer can already
  spawn a shell, so this adds little exposure, but a write path should still refuse odd input.

### Encoding and line endings

- The fs worker's read already decodes UTF-8. It now also says whether the text is **editable**:
  the decoded text encodes back to the same bytes. Latin-1 and other invalid UTF-8 would come back
  with replacement characters, so those files stay read-only with a note ("not UTF-8").
- A **BOM** is taken off on load (CodeMirror would show it as a special character) and put back on
  write.
- **Line endings**: the editor works on `\n`, and every comparison with the disk text goes through
  the same normalisation. A file whose lines mostly end in `\r\n` is written back with `\r\n`. A file
  with mixed endings is written with the most common one, and the tab says so before the first save.

### Cleanup on save

One pure function, `cleanOnSave(text, keepLines, opts)`, unit-tested, applied as an editor change
just before the write (so the buffer matches the disk and ⌘Z brings the spaces back):

- **Trailing whitespace** (spaces and tabs) is removed from every line, except the lines holding a
  cursor, so someone in the middle of indenting a new line keeps their spaces.
- **Some files keep trailing whitespace**, because it means something there: markdown (`.md`,
  `.markdown`, `.mdx`; two spaces end a line), and `.diff`, `.patch` and `.snap`. VS Code makes the
  markdown exception by default.
- **Trailing blank lines** are removed and the file ends with exactly one newline (an empty file
  stays empty). A line with a cursor is kept.
- Both run on save only. Stripping while typing would move text under the cursor.

### Indentation

- New setting **`editorIndent: 2 | 4`** (default 2), in Settings under a new Editor section, through
  `updateSettings`.
- **A file's own indentation wins over the setting.** On load, the editor looks at the indented
  lines: mostly tabs → tab indentation; mostly spaces → the most common step between indent levels
  (2, 4, 8). The setting applies to files with no indentation to go on. `Makefile`, `*.mk`, `*.go`
  and `go.mod` always use tabs: a Makefile's recipe lines must start with one, and `gofmt` writes
  them.
- **Tab** inserts spaces up to the next indent stop (a tab in a tab-indented file); with a
  selection it indents every selected line by one level. CodeMirror's own `insertTab` always
  inserts a tab character, so this is a small command of ours.
- **Shift-Tab** removes one level from the line or every selected line (`indentLess`).
- **Enter** keeps the indentation and adds a level after a block opener (`{`, `(`, `[`, Python's
  `:`, and the like) from the language grammar (`insertNewlineAndIndent`). Typing `}` puts it back
  one level (`indentOnInput`). A file with no grammar keeps the previous line's indentation.
- **Backspace** in leading spaces removes back to the previous indent stop (CodeMirror's default).

### Highlighting and look

- The editor takes the file tab's look: its font, size and line height, the gutter of line numbers,
  and its colours. One `HighlightStyle` maps CodeMirror's token tags to the **same theme variables
  `App.css` gives highlight.js** (`--blue` keywords and titles, `--accent` strings, `--amber`
  numbers and types, `--faint` italic comments, `--red` variables). Switching between the view and
  Edit doesn't change colours, and a theme switch reaches the editor with no editor theme of its
  own.
- Markdown in Edit: `**bold**` shows bold and `_italic_` italic with their markers visible and
  dimmed, headings in the heading colour, code spans in the code colour. Nothing is hidden or
  rendered.
- The two highlighters split some tokens differently, so a few tokens can differ in colour between
  the view and Edit. The common ones match through the shared variables.

### Keys and focus

- The editor's keymap is listed by us (CodeMirror's default keymap minus what clashes), so the app's
  shortcuts keep working. The app's window handler sees a key after CodeMirror, and skips one the
  editor used (`defaultPrevented`).
- ⌘K and Ctrl-K stay the palette: CodeMirror's Ctrl-K (`deleteToLineEnd`, mac) and Shift-⌘K (delete
  line) are dropped. ⌘T stays a new terminal.
- **Find in the editor is the editor's search** (find and replace in the file): ⌘F, and Ctrl+Shift+F
  on Linux and Windows, which the app's handler hands to the editor when it has focus. Elsewhere
  they stay the terminal find.
- ⌘[ and ⌘] are CodeMirror's indent less and more; the app doesn't use them.
- The Edit menu's Undo and Redo reach CodeMirror's history (it handles the `historyUndo` and
  `historyRedo` input events).
- **Focus**: a click in a pane calls `focusEntry`, which focuses `[data-entry=<id>]`. The editor puts
  `data-entry` on CodeMirror's content element, so a click in the text keeps the caret there, and
  marks its search panel `data-keep-focus` so its inputs keep focus too.

### Files that change on disk while editing

This is the common case in minmux: the agent beside the tab is writing the same file.

- **No unsaved changes:** the editor follows the file as the view does (`RELOAD_MS`). The new text
  is compared with the base string (not the document), and the difference goes in as one editor
  change covering only the part that differs (common prefix and suffix), so the cursor, selection,
  scroll and undo history stay. The base moves to the new text.
- **Unsaved changes:** the editor stops following. A bar says the file changed on disk, with
  **Reload** (take theirs; our changes go after a confirm) and **Keep mine** (the next save
  overwrites without asking). No merge view.
- **The file deleted while editing:** the bar says so, and Save writes it again only after a
  confirm. (The write path refuses to create files, so this is the one case it does, with the path
  the entry already had.)

### Unsaved changes

- An entry with unsaved changes shows a dot on its surface tab.
- **Closing it** (its surface tab, its pane, its tab) goes through `requestCloseEntry` and asks
  **Save**, **Discard** or **Cancel**. The close confirm has one action button today, so `file` is a
  new kind with its own dialog; a save that fails or answers `changed` leaves the entry open.
  `lib/close-confirm` counts unsaved files in pane and tab closes.
- **A save in flight** counts as unsaved for these guards, and quitting waits for it (a few
  seconds at most) before the save worker is stopped: stopping it mid-write leaves the file half
  written.
- **Leaving the page** (⌘R, force reload, ⌘W's Close Window on macOS, the red button, quit): while
  any file is unsaved, the renderer sets `beforeunload`, and main handles the window's
  `will-prevent-unload` with a dialog naming the files: **Discard** or **Cancel**. Without a
  handler in main, Electron cancels the unload silently. Main also hears the unsaved count from the
  renderer and checks it first in `before-quit`, ahead of the live-terminal confirm, regardless of
  live terminals and the "Don't warn again" setting, and before the drain hides the window.
- **How a quit knows what's unsaved:** it asks the page once, when it decides. The page settles
  pending checks and waits for its saves (4 s at most), then answers; no answer within 6 s, or no
  page ready to give one, falls back to the list the page last pushed. It never reads silence as
  "nothing unsaved". The pushed list only names files in the unload dialog.
- What's not covered: an OS shutdown that kills the app at once, a renderer crash, and text typed
  in the second or two between a quit's check and the window closing (in full screen, where the
  window isn't hidden first). Unsaved text is lost there, as it is in a terminal's scrollback.

### Performance

- Nothing loads until the first Edit; the editor runs only in a file tab on screen. A hidden editor
  is a kept `EditorState` doing no work, and the read-only path is unchanged.
- Typing costs about 1 to 2 ms per key for the parse (measured above), plus the DOM update, on the
  renderer's main thread. That thread also feeds xterm, so step 2 runs the `MINMUX_PERF=1`
  keystroke suite with an editor open beside a terminal, typing into the editor and into the
  terminal in turn, and records the numbers in the PR.
- Following a file while editing re-reads at the rate file tabs already do and applies a change
  only when the text differs from the base. Hashing for a save runs in the fs worker.

## Challenges

**Monaco would give VS Code's exact behaviour.** It's about 5 MB and runs its own workers, and it
brings its own model of themes, keys and focus. For edits inside a pane that's too heavy, and its
start-up cost lands on the first Edit.

**A `<textarea>` with highlighting drawn underneath is the lightest editor possible.** The two
layers drift with long lines, IME and zoom; undo is the browser's; and it slows down past a few
thousand lines. CodeMirror's 102 KB gzip, loaded on demand, buys all of that.

**Making the Source view itself editable** (no Edit button) is what VS Code does. Every Source view
would then load CodeMirror, and an agent's write into a file someone is reading would compete with
the cursor. The read-only view stays the default, and Edit is one click.

**One highlighter for both views.** CodeMirror's parser could replace highlight.js in the view
too, so colours match exactly. That changes a working view for a small gain; a later PR can do it
if the differences show.

**Trimming the whole file makes noisy diffs** in files that already have trailing whitespace: the
first save changes lines nobody touched. VS Code trims the whole file, and so do we: trimming only
lines changed in this session needs a record of them for a small gain.

**Writing in place isn't atomic.** A temp file and a rename would be, at the cost of symlinks,
hard links, owner and mode. Agents and their file watchers expect the same inode; we write in
place, and write before truncating so the file never reads empty.

**Mirroring unsaved text to main** would survive a renderer crash. It adds a channel that carries
every buffer for a rare case. Left out; the unload and quit guards cover the common ways to lose
text.

## Steps

1. **The save path**, no UI: the fs worker's `writefile` op (base hash check, `r+` write then
   `ftruncate`, never re-sent, `unknown` on a hang), `fs:write-file` in main (input checks, WSL
   shares without retry after a hang), the `editable` flag on reads, and the pure helpers
   (`cleanOnSave`, line endings, BOM, indentation detection) with their tests.
2. **The editor, safe to use**: Edit and Done in file tabs, the CodeMirror chunk, languages on
   demand, the highlight style, `editorIndent` and the indentation keys, the keymap and focus,
   ⌘S with cleanup and the `changed` answer, find. Every guard against losing text lands here too:
   the editor state and base in the file store, peeks kept on Edit, no eviction of unsaved entries,
   the unsaved dot, close confirms with Save/Discard/Cancel, the unload and quit guards. Real-app
   check and the perf suite.
3. **Living with agents**: following the file while clean, the changed-on-disk bar while dirty, and
   a deleted file. Until this lands, an editor doesn't follow the file, and a save over an agent's
   change is caught by the base hash.

## Settled in discussion

- Save trims trailing whitespace on **every line** (except cursor lines and the files above), as
  VS Code does. Noisy first diffs are accepted for the simpler rule.
- `editorIndent` defaults to **2**; a file's own indentation wins.

## Not in scope

- Creating, renaming or deleting files (beyond saving back a file deleted while editing).
- Autosave.
- A merge view for conflicting changes.
- Language servers, completion, lint, format on save.
- Multiple cursors beyond CodeMirror's defaults; vim or emacs keymaps.
- Editing over SSH.
- Keeping unsaved text across a quit or a renderer crash.
