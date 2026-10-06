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
  private checking = new Map<string, boolean>() // folder → a re-check is owed after this one
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
    const lose = () => {
      if (!this.watches.has(dir)) return
      this.remove(dir)
      this.emit({ event: "lost", dir }) // main re-adds it if it's still wanted (and exists)
      this.mark(dir)
      this.mark(path.dirname(dir)) // the folder that actually changed
    }
    const check = () => {
      if (this.checking.has(dir)) return void this.checking.set(dir, true) // once more after
      this.checking.set(dir, false)
      void this.idOf(dir).then((id) => {
        const again = this.checking.get(dir)
        this.checking.delete(dir)
        if (!this.watches.has(dir)) return
        if (id === null || id !== this.ids.get(dir)) return lose()
        if (again) check()
      })
    }
    // The baseline before the watch starts: a folder replaced right after still differs.
    const id = this.idNow(dir)
    const w = this.watchFn(
      dir,
      (type) => {
        if (type === "change" && this.linux) return
        if (type === "rename" && this.linux) check() // maybe the folder itself
        this.mark(dir)
      },
      lose,
    )
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
