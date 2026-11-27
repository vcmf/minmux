// An edited file's text on its way in and out of the editor (docs/design/FILE_EDITING.md): BOM
// and line endings, the cleanup on save, and the indentation a file already uses. Pure.

export type Eol = "\n" | "\r\n" | "\r" // "\r": classic Mac

/** A file's text as the editor holds it (`\n` lines, no BOM), and how to write it back. */
export interface EditorText {
  text: string
  bom: boolean
  eol: Eol
  mixed: boolean // more than one ending in it: written back with `eol` throughout
}

const BOM = "\uFEFF"

/** The disk text, split into the editor's text and the way it was written. */
export function fromDisk(raw: string): EditorText {
  const bom = raw.startsWith(BOM)
  const body = bom ? raw.slice(1) : raw
  // The editor splits lines as CodeMirror does: at \r\n, \n and a lone \r.
  const crlf = body.match(/\r\n/g)?.length ?? 0
  const lf = (body.match(/\n/g)?.length ?? 0) - crlf
  const cr = (body.match(/\r/g)?.length ?? 0) - crlf
  const eol: Eol = crlf > lf && crlf >= cr ? "\r\n" : cr > lf ? "\r" : "\n"
  return {
    text: crlf || cr ? body.replace(/\r\n?/g, "\n") : body,
    bom,
    eol,
    mixed: [crlf, lf, cr].filter((n) => n > 0).length > 1,
  }
}

/** The editor's text as it goes to disk. */
export function toDisk(text: string, how: { bom: boolean; eol: Eol }): string {
  const body = how.eol === "\n" ? text : text.replace(/\n/g, how.eol)
  return how.bom ? BOM + body : body
}

const KEEPS_TRAILING = new Set(["md", "markdown", "mdx", "diff", "patch", "snap"])

/** Trailing whitespace means something in this file (a markdown line break, a diff's context). */
export function keepsTrailingSpace(path: string): boolean {
  const name = path.split(/[\\/]/).pop() ?? ""
  const i = name.lastIndexOf(".")
  return i > 0 && KEEPS_TRAILING.has(name.slice(i + 1).toLowerCase())
}

/** One edit of the cleanup: replace [from, to) with `insert`. */
export interface TextChange {
  from: number
  to: number
  insert: string
}

// Trailing spaces and tabs off every line (unless `keepTrailing`), trailing blank lines off with
// exactly one final newline. Lines in `keep` (0-based: the cursors') stay as they are. The edits
// are in order and don't overlap, so the editor applies them as one undoable change.
/** The cleanup on save, as edits. */
export function saveCleanup(
  text: string,
  keep: ReadonlySet<number>,
  keepTrailing = false,
): TextChange[] {
  const lines = text.split("\n")
  const starts: number[] = []
  let at = 0
  for (const l of lines) {
    starts.push(at)
    at += l.length + 1
  }
  // The last line kept: the last with text in it, or a kept (cursor) line after it.
  let last = -1
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!/^[ \t]*$/.test(lines[i] ?? "") || keep.has(i)) {
      last = i
      break
    }
  }
  const changes: TextChange[] = []
  if (!keepTrailing) {
    for (let i = 0; i <= last; i++) {
      if (keep.has(i)) continue
      const l = lines[i] ?? ""
      const start = starts[i] ?? 0
      const end = l.replace(/[ \t]+$/, "").length
      if (end < l.length) changes.push({ from: start + end, to: start + l.length, insert: "" })
    }
  }
  if (last === -1) {
    // Nothing but blank lines: an empty file.
    if (text.length) changes.push({ from: 0, to: text.length, insert: "" })
    return changes
  }
  // A cursor on the empty line after the final newline: the file already ends in one.
  if (last === lines.length - 1 && lines[last] === "") return changes
  const lastEnd = (starts[last] ?? 0) + (lines[last] ?? "").length
  const tail = text.slice(lastEnd)
  if (tail !== "\n") changes.push({ from: lastEnd, to: text.length, insert: "\n" })
  return changes
}

/** `changes` applied to `text` (tests, and anything without an editor). */
export function applyChanges(text: string, changes: readonly TextChange[]): string {
  let out = ""
  let at = 0
  for (const c of changes) {
    out += text.slice(at, c.from) + c.insert
    at = c.to
  }
  return out + text.slice(at)
}

/** How a file indents: tabs, or spaces in steps of `width`. */
export interface Indent {
  tabs: boolean
  width: number
}

const ALWAYS_TABS = /(^|[\\/])(Makefile|GNUmakefile|makefile|go\.mod|go\.work)$|\.(mk|go)$/

// Makefiles and Go always use tabs (a recipe needs one; `gofmt` writes them).
/** The indentation a file already uses; `fallback` spaces when it shows none. */
export function detectIndent(text: string, path: string, fallback: number): Indent {
  if (ALWAYS_TABS.test(path)) return { tabs: true, width: fallback }
  let tabbed = 0
  let spaced = 0
  const steps = new Map<number, number>()
  let prev = 0
  for (const line of text.split("\n", 2000)) {
    if (line.trim() === "") continue
    const lead = /^[ \t]*/.exec(line)![0]
    if (lead.startsWith("\t")) {
      tabbed++
      prev = 0
      continue
    }
    const n = lead.length
    if (n > 0) spaced++
    // A step in from the line above (a block); one space in is usually a comment's star.
    const step = n - prev
    if (step > 1) steps.set(step, (steps.get(step) ?? 0) + 1)
    prev = n
  }
  if (tabbed > spaced) return { tabs: true, width: fallback }
  let width = fallback
  let most = 0
  for (const [step, count] of steps) {
    if (step !== 2 && step !== 4 && step !== 8) continue // 3 or 7: aligned, not a block
    if (count > most || (count === most && step < width)) {
      most = count
      width = step
    }
  }
  return { tabs: false, width }
}
