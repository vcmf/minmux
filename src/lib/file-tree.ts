// Pure model for the lazy file browser + a bounded per-cwd cache. All the risky
// logic (tree state transitions, the DFS that decides visible rows, the LRU) lives
// here and is unit-tested; the panel component is a thin shell that does the I/O
// (readdir) and renders visibleRows(). No React, no IPC, no time.

import { previewEntries, type DirListing } from "./dir-listing"

/** Join a dir + entry name into a path (no double slash at the root). */
export const joinPath = (dir: string, name: string) =>
  dir.endsWith("/") ? dir + name : `${dir}/${name}`

/** Last path segment (for the panel header). */
export const baseName = (p: string) =>
  p
    .replace(/[\\/]+$/, "")
    .split(/[\\/]/)
    .pop() || p

/** One browser's state: the folder it's rooted at, cached listings per directory,
 *  and which directories are expanded. Immutable — every op returns a new state. */
export interface FileTreeState {
  root: string
  listings: Record<string, DirListing> // dir path → its (capped) listing
  expanded: ReadonlySet<string> // expanded dir paths
  showAll?: ReadonlySet<string> // big folders the user chose to see in full
}

/** Same entries, cap state and total: a re-read that changed nothing. */
export function sameListing(a: DirListing | undefined, b: DirListing): boolean {
  if (!a || a.truncated !== b.truncated || a.total !== b.total) return false
  if (!!a.error !== !!b.error) return false // a successful read replaces a failed one
  if (a.entries.length !== b.entries.length) return false
  return a.entries.every((e, i) => e.name === b.entries[i]!.name && e.isDir === b.entries[i]!.isDir)
}

/** We hold a usable listing for `dir` (not missing, not a failed read). */
export const hasListing = (s: FileTreeState, dir: string) => {
  const l = s.listings[dir]
  return !!l && !l.error
}

export interface VisibleRow {
  path: string // unique key + (for files/dirs) the absolute path
  name: string
  depth: number
  kind: "dir" | "file" | "note" | "more"
  expanded: boolean // meaningful for dirs
  dir?: string // "more" / "note" rows: the folder they belong to
  hidden?: number // "more" rows: how many entries aren't shown
}

/** Flatten the tree into the rows to render, honoring expanded + loaded listings
 *  (depth-first, dirs already sorted first by the backend). A dir that's expanded
 *  but not yet loaded simply shows no children until its listing arrives. A
 *  truncated listing appends a non-interactive "… more" note row. Pure. */
export function visibleRows(s: FileTreeState): VisibleRow[] {
  const out: VisibleRow[] = []
  const walk = (dir: string, depth: number) => {
    const listing = s.listings[dir]
    if (!listing) return
    if (listing.error) {
      // Not "empty": say so (expanding it again, or Refresh, retries).
      out.push({
        path: `note:${dir}`,
        name: "Couldn't read this folder",
        depth,
        kind: "note",
        expanded: false,
      })
      return
    }
    const total = listing.total ?? listing.entries.length
    const { shown, hidden } = previewEntries(listing.entries, total, !!s.showAll?.has(dir))
    for (const e of shown) {
      const path = joinPath(dir, e.name)
      if (e.isDir) {
        const expanded = s.expanded.has(path)
        out.push({ path, name: e.name, depth, kind: "dir", expanded })
        if (expanded) walk(path, depth + 1)
      } else {
        out.push({ path, name: e.name, depth, kind: "file", expanded: false })
      }
    }
    // A previewed big folder: "N more · Show all · Open in Finder".
    if (shown.length < listing.entries.length) {
      out.push({
        path: `more:${dir}`,
        name: `${hidden.toLocaleString("en-US")} more`,
        depth,
        kind: "more",
        expanded: false,
        dir,
        hidden,
      })
    } else if (listing.truncated) {
      // Past the backend's cap: only the file manager can show the rest.
      out.push({
        path: `note:${dir}`,
        name: hidden > 0 ? `${hidden.toLocaleString("en-US")} more` : "… more (truncated)",
        depth,
        kind: "note",
        expanded: false,
        dir,
        hidden,
      })
    }
  }
  walk(s.root, 0)
  return out
}

/** The open folders you can see: the root, then expanded folders whose parents are all
 *  expanded (one under a collapsed parent stays expanded but hidden — no need to read it). */
export function shownOpenDirs(s: FileTreeState): string[] {
  const out: string[] = []
  const walk = (dir: string) => {
    out.push(dir)
    for (const e of s.listings[dir]?.entries ?? []) {
      const p = joinPath(dir, e.name)
      if (e.isDir && s.expanded.has(p)) walk(p)
    }
  }
  walk(s.root)
  return out
}
