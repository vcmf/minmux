// What the fs worker (a utility process) does for main: one request in, one reply out, plus
// unsolicited watch events. Kept apart from the process glue so it's unit-tested in-process.
import fs from "node:fs"
import path from "node:path"
import { readDirListing } from "./read-dir"
import type { DirListing } from "../src/lib/dir-listing"
import { readFileForTab } from "./read-file"
import type { FileData, FileStamp } from "../src/lib/file-tab"

export type FsCall =
  | { op: "readdir" | "stat" | "watch" | "unwatch"; path: string }
  | { op: "gitroots"; paths: string[]; real: boolean } // `real`: resolve symlinks first
  | { op: "readfile"; path: string; since?: FileStamp } // a file tab's read (electron/read-file)
export type FsRequest = FsCall & { id: number }

/** Each folder's checkout root (null: in none); a folder whose search failed is left out. */
export type GitRootsResult = { roots: Record<string, string | null> }

export type FsResult =
  DirListing | { isDir: boolean } | { watching: boolean } | GitRootsResult | FileData

export type FsReply =
  { id: number; ok: true; value: FsResult } | { id: number; ok: false; code: string }

/** Sent without a request: folders whose listing may have changed, or whose watcher is gone. */
export type FsEvent = { event: "changed"; dirs: string[] } | { event: "lost"; dir: string }

export const WATCH_BATCH_MS = 250

type Watch = { close(): void }
type WatchFn = (
  dir: string,
  onEvent: (type: string, name: string | null) => void,
  onError: () => void,
) => Watch

const realWatch: WatchFn = (dir, onEvent, onError) => {
  // Non-recursive: a change deep inside a collapsed subfolder fires nothing.
  const w = fs.watch(dir, { persistent: false }, (type, name) =>
    onEvent(type, name?.toString() ?? null),
  )
  w.on("error", onError)
  return w
}

/** A folder's identity (device + inode), or null when it's gone. */
type IdOf = (dir: string) => Promise<string | null>
const realIdOf: IdOf = (dir) =>
  fs.promises.stat(dir).then(
    (st) => `${st.dev}:${st.ino}`,
    () => null,
  )
const realIdNow = (dir: string): string | null => {
  try {
    const st = fs.statSync(dir) // the worker's own thread: a dead mount hangs it, not main
    return `${st.dev}:${st.ino}`
  } catch {
    return null
  }
}

export interface WatchesOpts {
  watchFn?: WatchFn
  // Linux (inotify): content writes ("change") come apart from entry changes, so they're
  // skipped; and a watch dies with its folder (going silent, reporting the folder's own name
  // once), so after a "rename" the folder's identity is checked. macOS (FSEvents) reports an
  // append as "rename" too and follows the path, so neither applies there.
  linux?: boolean
  idOf?: IdOf // async identity, for checks
  idNow?: (dir: string) => string | null // sync identity, the baseline taken before watching
}

/** The worker's folder watchers. Events are batched (one "changed" per WATCH_BATCH_MS). A
 *  folder deleted or replaced under its watcher (`rm -rf dist && build`) is reported lost:
 *  main re-adds it, and a re-add re-reads it. */
export class Watches {
  private watches = new Map<string, Watch>()
  private ids = new Map<string, string | null>() // folder → identity when watched
  private dirty = new Set<string>()
  private timer: ReturnType<typeof setTimeout> | null = null
  private readonly watchFn: WatchFn
  private readonly linux: boolean
  private readonly idOf: IdOf
  private readonly idNow: (dir: string) => string | null

  constructor(
    private readonly emit: (e: FsEvent) => void,
    o: WatchesOpts = {},
  ) {
    this.watchFn = o.watchFn ?? realWatch
    this.linux = o.linux ?? process.platform === "linux"
    this.idOf = o.idOf ?? realIdOf
    this.idNow = o.idNow ?? realIdNow
  }

  add(dir: string): void {
    if (this.watches.has(dir)) return
    const self: { w?: Watch } = {} // this watcher, once made
    const mine = () => !!self.w && this.watches.get(dir) === self.w // not replaced since
    const lose = () => {
      if (!mine()) return
      this.remove(dir)
      this.emit({ event: "lost", dir }) // main re-adds it if it's still wanted (and exists)
      this.mark(dir)
      this.mark(path.dirname(dir)) // the folder that actually changed
    }
    let checking = false
    let owed = false // a rename arrived during the check: check once more after it
    const check = () => {
      if (checking) return void (owed = true)
      checking = true
      void this.idOf(dir).then((id) => {
        checking = false
        if (!mine()) return // a check from a watcher that's since been replaced
        const was = this.ids.get(dir)
        if (id === null || (was != null && id !== was)) return lose()
        if (was == null) this.ids.set(dir, id) // no baseline yet: this is it
        if (owed) {
          owed = false
          check()
        }
      })
    }
    // Linux: the baseline before the watch starts (a folder replaced right after differs).
    const id = this.linux ? this.idNow(dir) : null
    const w = this.watchFn(
      dir,
      (type) => {
        if (type === "change" && this.linux) return
        if (type === "rename" && this.linux) check() // maybe the folder itself
        this.mark(dir)
      },
      lose,
    )
    self.w = w
    this.watches.set(dir, w)
    this.ids.set(dir, id)
  }

  remove(dir: string): void {
    this.watches.get(dir)?.close()
    this.watches.delete(dir)
    this.ids.delete(dir)
  }

  get size(): number {
    return this.watches.size
  }

  closeAll(): void {
    for (const dir of [...this.watches.keys()]) this.remove(dir)
    if (this.timer) clearTimeout(this.timer)
  }

  private mark(dir: string): void {
    this.dirty.add(dir)
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = null
      const dirs = [...this.dirty]
      this.dirty.clear()
      if (dirs.length) this.emit({ event: "changed", dirs })
    }, WATCH_BATCH_MS)
  }
}

const MAX_DEPTH = 128
const GITFILE_MAX = 1024

type Mark = "repo" | "broken" | "none"
const missing = (e: unknown) => {
  const code = (e as { code?: string }).code
  return code === "ENOENT" || code === "ENOTDIR"
}

// Missing: false; another error (a share that won't answer) isn't "missing": thrown.
const exists = (p: string) =>
  fs.promises.stat(p).then(
    () => true,
    (e: unknown) => {
      if (missing(e)) return false
      throw e
    },
  )

// What git makes of a folder's `.git`: a folder holding HEAD is a repo (one without isn't, and
// the search goes on up); a file is a worktree's or submodule's link, and one whose target is
// gone is "not a repository" (git stops there too).
async function gitMark(dir: string): Promise<Mark> {
  const dotGit = path.join(dir, ".git")
  let st: fs.Stats
  try {
    st = await fs.promises.stat(dotGit)
  } catch (e) {
    if (missing(e)) return "none"
    throw e
  }
  // Only "missing" decides; another error (a flaky share) fails the search: git's turn.
  if (st.isDirectory()) return (await exists(path.join(dotGit, "HEAD"))) ? "repo" : "none"
  if (!st.isFile()) return "broken" // (a FIFO would block the read)
  const fh = await fs.promises.open(dotGit, "r")
  try {
    const buf = Buffer.alloc(GITFILE_MAX)
    const { bytesRead } = await fh.read(buf, 0, GITFILE_MAX, 0)
    const m = /^gitdir: *([^\r\n]+?)\s*(?:\n|$)/.exec(buf.toString("utf8", 0, bytesRead)) // line 1
    if (!m) return "broken"
    return (await exists(path.resolve(dir, m[1]!))) ? "repo" : "broken"
  } finally {
    await fh.close()
  }
}

// Git's own upward search, as file checks: the nearest folder at or above `dir` whose `.git`
// git would take, so a nested worktree / submodule wins over the repo around it. With `real`,
// symlinks are resolved first (git walks the real parents), so the root is spelled as git
// spells it. A folder that's gone (a removed tree) is in none, once some folder above it is
// there; nothing at all there (a stopped distro's share) is an error. `marks` is shared
// across a batch.
/** The checkout a folder lies in (null: none). */
export async function gitRootOf(
  dir: string,
  real: boolean,
  marks: Map<string, Promise<Mark>> = new Map(),
): Promise<string | null> {
  let d = path.resolve(dir)
  try {
    if (real) d = await fs.promises.realpath(d)
    else await fs.promises.stat(d)
  } catch (e) {
    if (!missing(e)) throw e
    for (let up = path.dirname(d); up !== d; d = up, up = path.dirname(d))
      if (await exists(up)) return null
    throw e
  }
  for (let i = 0; i < MAX_DEPTH; i++) {
    let mark = marks.get(d)
    if (!mark) marks.set(d, (mark = gitMark(d)))
    const m = await mark
    if (m === "repo") return d
    if (m === "broken") return null
    const up = path.dirname(d)
    if (up === d) return null
    d = up
  }
  return null
}

export const PATH_MS = 5000

// A folder on a dead mount never answers: after PATH_MS it's left out (failed: git's turn) so
// the folders beside it still get theirs.
/** Each folder's checkout, one search per folder sharing its parents' checks. */
export async function gitRoots(
  paths: string[],
  real: boolean,
  pathMs = PATH_MS,
): Promise<Record<string, string | null>> {
  const marks = new Map<string, Promise<Mark>>()
  const out: Record<string, string | null> = {}
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<void>((resolve) => (timer = setTimeout(resolve, pathMs)))
  const all = Promise.all(
    paths.map((p) =>
      gitRootOf(p, real, marks).then(
        (r) => void (out[p] = r),
        () => {}, // failed: left out
      ),
    ),
  )
  await Promise.race([all, late])
  clearTimeout(timer)
  return { ...out } // (a late answer can't change what was sent)
}

/** Run one request; never throws (a failure is a reply with the error code). */
export async function handleFsRequest(req: FsRequest, watches?: Watches): Promise<FsReply> {
  try {
    let value: FsResult
    if (req.op === "readdir") value = await readDirListing(req.path)
    else if (req.op === "stat") value = { isDir: (await fs.promises.stat(req.path)).isDirectory() }
    else if (req.op === "gitroots") value = { roots: await gitRoots(req.paths, req.real) }
    else if (req.op === "readfile") value = await readFileForTab(req.path, undefined, req.since)
    else if (req.op === "watch") {
      watches?.add(req.path) // sync: if it hangs (a dead mount), main sees this request hang
      value = { watching: true }
    } else {
      watches?.remove(req.path)
      value = { watching: false }
    }
    return { id: req.id, ok: true, value }
  } catch (e) {
    return { id: req.id, ok: false, code: (e as { code?: string }).code ?? "EUNKNOWN" }
  }
}
