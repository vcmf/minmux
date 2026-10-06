// The files browser's one-level folder read, bounded so a huge folder never blocks main (which
// carries every terminal's I/O). A symlink's dirent doesn't say whether it points at a folder,
// so it needs a stat. Stat-ing every link of a 35k-entry node_modules/.pnpm at once blocked the
// event loop for ~150 ms. Instead links are stat-ed a batch at a time, yielding between
// batches, and never more than the cap's worth of them.
import fs from "node:fs"
import path from "node:path"
import { READDIR_CAP, sortEntries, toDirListing, type DirListing } from "../src/lib/dir-listing"

export const STAT_BATCH = 64
// A link into a hung mount (NFS, autofs, 9p) must not hold the listing: past this, the
// batch's unresolved links show as files.
export const STAT_TIMEOUT_MS = 2000

const yieldToLoop = () => new Promise<void>((r) => setImmediate(r))
const timeout = (ms: number) => new Promise<void>((r) => setTimeout(r, ms).unref())

type Ent = { name: string; isDir: boolean; link: boolean }

/** List one folder: `.git` dropped, dirs first, capped; symlinked dirs browse as dirs. */
export async function readDirListing(
  dir: string,
  {
    cap = READDIR_CAP,
    batch = STAT_BATCH,
    statTimeout = STAT_TIMEOUT_MS,
  }: { cap?: number; batch?: number; statTimeout?: number } = {},
): Promise<DirListing> {
  const ents = await fs.promises.readdir(dir, { withFileTypes: true })
  const all: Ent[] = ents
    .filter((e) => e.name !== ".git")
    .map((e) => ({ name: e.name, isDir: e.isDirectory(), link: e.isSymbolicLink() }))
  const links = all.filter((e) => e.link)
  // Few enough links (the common case): resolve them all, so the order is exact. Otherwise
  // (a pnpm store) pick the kept entries by the dirent's own type first and resolve only
  // theirs; a symlinked folder past the cap may then sort as a file and stay out of the
  // listing, which says how many entries it doesn't show.
  const candidates = links.length <= cap ? all : sortEntries(all).slice(0, cap)
  await resolveLinks(
    dir,
    candidates.filter((e) => e.link),
    batch,
    statTimeout,
  )
  return toDirListing(candidates, cap, all.length)
}

async function resolveLinks(dir: string, links: Ent[], batch: number, ms: number) {
  for (let i = 0; i < links.length; i += batch) {
    if (i > 0) await yieldToLoop()
    const stats = links.slice(i, i + batch).map(async (e) => {
      try {
        const isDir = (await fs.promises.stat(path.join(dir, e.name))).isDirectory()
        e.isDir = isDir
      } catch {
        // dangling link → a file
      }
    })
    await Promise.race([Promise.all(stats), timeout(ms)])
  }
}
