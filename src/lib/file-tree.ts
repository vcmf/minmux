// Pure model for the lazy file browser + a bounded per-cwd cache. All the risky
// logic (tree state transitions, the DFS that decides visible rows, the LRU) lives
// here and is unit-tested; the panel component is a thin shell that does the I/O
// (readdir) and renders visibleRows(). No React, no IPC, no time.

import { previewEntries, type DirListing } from "./dir-listing"

/** Join a dir + entry name into a path (no double slash at the root). */
export const joinPath = (dir: string, name: string) =>
  dir.endsWith("/") ? dir + name : `${dir}/${name}`

/** Last path segment (for the panel header). */
export const baseName = (p: string) => p.replace(/\/+$/, "").split("/").pop() || p

/** One browser's state: the folder it's rooted at, cached listings per directory,
 *  and which directories are expanded. Immutable — every op returns a new state. */
export interface FileTreeState {
  root: string
  listings: Record<string, DirListing> // dir path → its (capped) listing
  expanded: ReadonlySet<string> // expanded dir paths
  showAll?: ReadonlySet<string> // big folders the user chose to see in full
}

export const emptyTree = (root: string): FileTreeState => ({
  root,
  listings: {},
  expanded: new Set(),
})

/** Cache a directory's listing (from readdir). Pure. */
export function setListing(s: FileTreeState, dir: string, listing: DirListing): FileTreeState {
  if (listing.error && s.listings[dir]) return s // a failed re-read keeps what we had
  return { ...s, listings: { ...s.listings, [dir]: listing } }
}

/** Expand/collapse a directory. Returns the new state and, if it was just expanded
 *  and isn't cached yet, the dir that needs a readdir (else null). Pure. */
export function toggleDir(
  s: FileTreeState,
  dir: string,
): {
  state: FileTreeState
  needsLoad: string | null
} {
  const expanded = new Set(s.expanded)
  if (expanded.has(dir)) {
    expanded.delete(dir)
    return { state: { ...s, expanded }, needsLoad: null }
  }
  expanded.add(dir)
  // Read it unless we hold a good listing (a failed read is retried on the next expand).
  const held = s.listings[dir]
  return { state: { ...s, expanded }, needsLoad: held && !held.error ? null : dir }
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

/** Show every entry of a big folder (past the first-10 preview). Pure. */
export function showAllIn(s: FileTreeState, dir: string): FileTreeState {
  return { ...s, showAll: new Set([...(s.showAll ?? []), dir]) }
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
      // Not "empty": say so (expanding it again retries).
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

/** The directories whose listings we hold and should re-read to refresh (root +
 *  every expanded dir). Used to background-refresh a restored tree. Pure. */
export function openDirs(s: FileTreeState): string[] {
  return [s.root, ...[...s.expanded].filter((d) => d !== s.root)]
}

/** LRU cache of file-tree states keyed by cwd. Bounds memory to `capacity` folders
 *  (each listing is itself capped by the backend), so browsing many folders can't
 *  grow it without limit. `get` and `set` both mark most-recently-used. */
export class FileTreeCache {
  private map = new Map<string, FileTreeState>() // insertion order = LRU → MRU
  constructor(private readonly capacity: number) {}

  get(cwd: string): FileTreeState | undefined {
    const v = this.map.get(cwd)
    if (v) {
      this.map.delete(cwd)
      this.map.set(cwd, v) // touch → MRU
    }
    return v
  }

  set(cwd: string, state: FileTreeState): void {
    this.map.delete(cwd) // re-insert so it becomes MRU
    this.map.set(cwd, state)
    while (this.map.size > this.capacity) {
      const lru = this.map.keys().next().value // oldest
      if (lru === undefined) break
      this.map.delete(lru)
    }
  }

  has(cwd: string): boolean {
    return this.map.has(cwd)
  }
  get size(): number {
    return this.map.size
  }
  /** Keys in LRU → MRU order (for tests/inspection). */
  keys(): string[] {
    return [...this.map.keys()]
  }
}
