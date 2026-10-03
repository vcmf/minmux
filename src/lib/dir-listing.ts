// Pure directory-listing logic for the files browser: filter noise, sort (dirs
// first, then alphabetical), and cap so a huge directory can't flood the renderer.
// Lives here (no DOM, no IPC) so the main-process readdir handler stays a thin shell
// and this — the risky comparator + off-by-one-prone cap — is unit-tested.

export interface DirEntry {
  name: string
  isDir: boolean
}

export interface DirListing {
  entries: DirEntry[] // dirs first, then alphabetical
  truncated: boolean // more entries existed than the cap (surfaced, not hidden)
  total?: number // how many entries the folder really has (after filtering) — the "N more" line
}

export const READDIR_CAP = 500

// A folder with more direct entries than this shows only its first BIG_FOLDER_PREVIEW, then
// "N more · Show all · Open in Finder" — generated/vendored folders (node_modules/.pnpm, build
// output) mustn't flood the tree; hand-written ones rarely come close.
export const BIG_FOLDER = 100
export const BIG_FOLDER_PREVIEW = 10

/** Which of a folder's entries to show: all, or a preview while it's big and not "show all". */
export function previewEntries<T>(
  entries: T[],
  total: number,
  showAll: boolean,
): { shown: T[]; hidden: number } {
  if (showAll || total <= BIG_FOLDER) return { shown: entries, hidden: total - entries.length }
  const shown = entries.slice(0, BIG_FOLDER_PREVIEW)
  return { shown, hidden: total - shown.length }
}

/** Filter `.git`, sort (dirs first, then name), and cap. Pure. */
export function toDirListing(entries: DirEntry[], cap: number = READDIR_CAP): DirListing {
  const filtered = entries
    .filter((e) => e.name !== ".git")
    .sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1))
  return {
    entries: filtered.slice(0, cap),
    truncated: filtered.length > cap,
    total: filtered.length,
  }
}
