// The files browser's one-level folder read, bounded so a huge folder never blocks main (which
// carries every terminal's I/O). A symlink's dirent doesn't say whether it points at a folder,
// so it needs a stat. Stat-ing every link of a 35k-entry node_modules/.pnpm at once blocked the
// event loop for ~150 ms. Instead: cap first (by the dirent's own type), then stat only the
// kept links, a batch at a time, yielding between batches.
import fs from "node:fs"
import path from "node:path"
import { READDIR_CAP, sortEntries, type DirListing } from "../src/lib/dir-listing"

export const STAT_BATCH = 64

const yieldToLoop = () => new Promise<void>((r) => setImmediate(r))

/** List one folder: `.git` dropped, dirs first, capped; symlinked dirs browse as dirs. */
export async function readDirListing(
  dir: string,
  { cap = READDIR_CAP, batch = STAT_BATCH }: { cap?: number; batch?: number } = {},
): Promise<DirListing> {
  const ents = await fs.promises.readdir(dir, { withFileTypes: true })
  const all = sortEntries(
    ents.map((e) => ({ name: e.name, isDir: e.isDirectory(), link: e.isSymbolicLink() })),
  )
  // Past the cap, which entries are kept is decided before links resolve: a symlinked folder
  // beyond it may sort as a file there, but it wouldn't be shown either way.
  const kept = all.slice(0, cap)
  const links = kept.filter((e) => e.link)
  for (let i = 0; i < links.length; i += batch) {
    if (i > 0) await yieldToLoop()
    await Promise.all(
      links.slice(i, i + batch).map(async (e) => {
        try {
          e.isDir = (await fs.promises.stat(path.join(dir, e.name))).isDirectory()
        } catch {
          // dangling link → a file
        }
      }),
    )
  }
  return {
    entries: sortEntries(kept).map(({ name, isDir }) => ({ name, isDir })),
    truncated: all.length > cap,
    total: all.length,
  }
}
