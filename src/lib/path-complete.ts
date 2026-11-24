// Folder-path completion for the folder tab's path box (VS Code-style): the text up to the
// last separator names a folder, the rest is a prefix of one of its subfolders. Pure — the
// component reads the folder (one read per folder, shared listings) and filters here.
import type { DirEntry } from "./dir-listing"

export interface PathQuery {
  base: string // the typed text up to and including the last separator (kept as typed: `~/…`)
  dir: string // the folder to list: `base` with `~` expanded, no trailing separator (but a root)
  prefix: string // the typed part of a subfolder's name
}

const SEP = /[\\/]/

/** Expand a leading `~` to `home` (none: unchanged). `win`: `~\` too. */
export function expandTilde(p: string, home: string, win = false): string {
  if (!home || !(win ? /^~(?:[\\/]|$)/ : /^~(?:\/|$)/).test(p)) return p
  return home.replace(/[\\/]+$/, "") + p.slice(1)
}

// `win`: `\` separates too (elsewhere it's part of a name).
/** Drop trailing separators, keeping a root (`/`, `C:\`). */
export function trimTrailingSep(p: string, win = false): string {
  const t = p.replace(win ? /[\\/]+$/ : /\/+$/, "")
  if (!t) return p.slice(0, 1) // "/"
  if (win && /^[A-Za-z]:$/.test(t)) return t + p.charAt(t.length) // "C:\"
  return t
}

// A UNC path lists only from its share on: \\server\share\…
const UNC_SHARE = /^[\\/]{2}[^\\/]+[\\/][^\\/]+[\\/]/

// Null when it names no folder yet: no separator, or not absolute once `~` is expanded.
/** Split typed text into the folder to list and the name prefix. */
export function splitPathInput(input: string, home: string, win: boolean): PathQuery | null {
  const sep = win ? SEP : /\//
  let cut = -1
  for (let i = input.length - 1; i >= 0; i--)
    if (sep.test(input[i]!)) {
      cut = i
      break
    }
  if (cut < 0) return null
  const base = input.slice(0, cut + 1)
  const expanded = expandTilde(base, home, win)
  const absolute = win
    ? /^[A-Za-z]:[\\/]/.test(expanded) || UNC_SHARE.test(expanded)
    : expanded.startsWith("/")
  if (!absolute) return null
  return { base, dir: trimTrailingSep(expanded, win), prefix: input.slice(cut + 1) }
}

// Hidden ones only once the prefix starts with `.`; `ci`: the file system ignores case.
/** Subfolder names starting with `prefix`, in listing order. */
export function matchDirs(entries: readonly DirEntry[], prefix: string, ci: boolean): string[] {
  const p = ci ? prefix.toLowerCase() : prefix
  const hidden = prefix.startsWith(".")
  const out: string[] = []
  for (const e of entries) {
    if (!e.isDir || (!hidden && e.name.startsWith("."))) continue
    if ((ci ? e.name.toLowerCase() : e.name).startsWith(p)) out.push(e.name)
  }
  return out
}

/** The longest prefix all `names` share (spelled as in the first one). */
export function commonPrefix(names: readonly string[], ci: boolean): string {
  if (!names.length) return ""
  const first = names[0]!
  let n = first.length
  for (const name of names) {
    let i = 0
    while (i < n && i < name.length && eq(first[i]!, name[i]!, ci)) i++
    n = i
  }
  return first.slice(0, n)
}

const eq = (a: string, b: string, ci: boolean) =>
  a === b || (ci && a.toLowerCase() === b.toLowerCase())

/** The separator to append after a completed name: the one the user typed last. */
export function sepOf(base: string): string {
  return base.endsWith("\\") ? "\\" : "/"
}
