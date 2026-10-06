// What the fs worker (a utility process) does for main: one request in, one reply out, plus
// unsolicited watch events. Kept apart from the process glue so it's unit-tested in-process.
import fs from "node:fs"
import path from "node:path"
import { readDirListing } from "./read-dir"
import type { DirListing } from "../src/lib/dir-listing"

export type FsCall = { op: "readdir" | "stat" | "watch" | "unwatch"; path: string }
export type FsRequest = FsCall & { id: number }

export type FsResult = DirListing | { isDir: boolean } | { watching: boolean }

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

/** The worker's folder watchers. Events are batched (one "changed" per WATCH_BATCH_MS). A
 *  watcher dies with its folder (Linux: inotify goes silent, reporting the folder's own name
 *  once), so after any "rename" the folder is checked: gone, or a new one in its place (a
 *  `rm -rf dist && build`), and the watcher is dropped and reported lost — main re-adds it. */
export class Watches {
  private watches = new Map<string, Watch>()
  private ids = new Map<string, string | null>() // folder → identity when watched
  private checking = new Set<string>()
  private dirty = new Set<string>()
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private readonly emit: (e: FsEvent) => void,
    private readonly watchFn: WatchFn = realWatch,
    // inotify reports content writes ("change") apart from entry changes; FSEvents (macOS)
    // reports an append as "rename" too, so only Linux can skip them.
    private readonly ignoreContent = process.platform === "linux",
    private readonly idOf: IdOf = realIdOf,
  ) {}

  add(dir: string): void {
    if (this.watches.has(dir)) return
    const lose = () => {
      if (!this.watches.has(dir)) return
      this.remove(dir)
      this.emit({ event: "lost", dir }) // main re-adds it if it's still wanted (and exists)
      this.mark(dir)
      this.mark(path.dirname(dir)) // the folder that actually changed
    }
    const check = () => {
      if (this.checking.has(dir)) return
      this.checking.add(dir)
      void this.idOf(dir).then((id) => {
        this.checking.delete(dir)
        if (!this.watches.has(dir)) return
        const was = this.ids.get(dir)
        if (id === null || (was && id !== was)) lose()
      })
    }
    const w = this.watchFn(
      dir,
      (type) => {
        if (type === "change" && this.ignoreContent) return
        if (type === "rename") check() // maybe the folder itself
        this.mark(dir)
      },
      lose,
    )
    this.watches.set(dir, w)
    this.ids.set(dir, null)
    void this.idOf(dir).then((id) => this.watches.has(dir) && this.ids.set(dir, id))
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

/** Run one request; never throws (a failure is a reply with the error code). */
export async function handleFsRequest(req: FsRequest, watches?: Watches): Promise<FsReply> {
  try {
    let value: FsResult
    if (req.op === "readdir") value = await readDirListing(req.path)
    else if (req.op === "stat") value = { isDir: (await fs.promises.stat(req.path)).isDirectory() }
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
