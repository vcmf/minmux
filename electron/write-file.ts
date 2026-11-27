// Save an edited file (docs/design/FILE_EDITING.md, "Saving"). Runs in the save worker (its own
// utility process, so a read stuck on a dead mount never takes a save down with it). Writes only
// over the bytes the editor started from (its base hash), in place: the file keeps its inode,
// owner, mode, hard links, and a symlink stays a symlink.
import fs from "node:fs"
import { FILE_READ_CAP, type SaveResult } from "../src/lib/file-tab"
import { hashBytes } from "./read-file"

// A lone UTF-16 surrogate can't be written as UTF-8 (it would become U+FFFD).
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/

/** Write `text` over `file` if its bytes still hash to `base` (`create`: only where none is). */
export async function writeFileForTab(
  file: string,
  text: string,
  base: string | null,
  create = false,
): Promise<SaveResult> {
  if (LONE_SURROGATE.test(text))
    return { kind: "error", message: "The text has a character that can't be saved" }
  const bytes = Buffer.from(text, "utf8")
  if (bytes.length > FILE_READ_CAP) return { kind: "error", message: "Too large to save" }
  if (create) {
    // Written back only where nothing is: a link whose target is gone isn't followed, and one
    // to a file is a file (`changed`, as `wx` would say).
    const link = await fs.promises.lstat(file).then(
      (st) => st.isSymbolicLink(),
      () => false,
    )
    if (link) {
      const resolves = await fs.promises.stat(file).then(
        () => true,
        () => false,
      )
      return resolves
        ? { kind: "changed" }
        : { kind: "error", message: "It's a link whose file is gone" }
    }
  }
  if (!create) {
    // A pipe or a device isn't opened for writing at all (that alone can block, or act).
    const kind = await fs.promises.stat(file).then(
      (st) => (st.isFile() ? "file" : "other"),
      (e: { code?: string }) => (e.code === "ENOENT" ? "missing" : "file"), // open says why
    )
    if (kind === "missing") return { kind: "missing" }
    if (kind === "other") return { kind: "error", message: "Not a file" }
  }
  let fh: fs.promises.FileHandle
  try {
    // `wx` fails if a file appeared meanwhile: then it's someone else's, not ours to replace.
    fh = await fs.promises.open(file, create ? "wx" : "r+")
  } catch (e) {
    const code = (e as { code?: string }).code
    if (code === "ENOENT") return { kind: "missing" }
    if (code === "EEXIST") {
      // Something took the name: a file is a change; anything else can't be saved over.
      const isFile = await fs.promises.stat(file).then(
        (st) => st.isFile(),
        () => true,
      )
      return isFile ? { kind: "changed" } : { kind: "error", message: "Not a file" }
    }
    return { kind: "error", message: String(e), unopened: true } // another share form may open
  }
  let closed = false
  try {
    const st = await fh.stat({ bigint: true })
    if (!st.isFile()) return { kind: "error", message: "Not a file" }
    // One file at a time, however it's named (a symlink, another case on APFS); a share that
    // reports no inode (0) keys by path.
    const key = st.ino ? `${st.dev}:${st.ino}` : `path:${file}`
    return await inodes.run(key, async (): Promise<SaveResult> => {
      let wrote = false // from the first write on, a failure may have left the file half written
      try {
        if (!create && !(await sameBytes(fh, base))) return { kind: "changed" }
        // Write first, then cut to length: the file never reads empty in between.
        wrote = true
        let put = 0
        while (put < bytes.length) {
          const { bytesWritten } = await fh.write(bytes, put, bytes.length - put, put)
          if (!bytesWritten) throw new Error("write made no progress")
          put += bytesWritten
        }
        await fh.truncate(bytes.length) // (an empty text: no write above, the truncate is it)
        const ours = await fh.stat()
        // A network share may report a failed write only at close (NFS: EDQUOT, EIO), and set
        // the time then: the stamp comes after it, unless another file took the name meanwhile
        // (an agent's rename into place): then ours, which won't match, so the tab re-reads.
        closed = true
        await fh.close()
        const now = await fs.promises.stat(file).catch(() => null)
        const after = now && now.ino === ours.ino && now.dev === ours.dev ? now : ours
        return {
          kind: "saved",
          stamp: {
            size: after.size,
            mtimeMs: after.mtimeMs,
            ctimeMs: after.ctimeMs,
            ino: after.ino,
          },
          hash: hashBytes(bytes),
        }
      } catch (e) {
        return wrote ? { kind: "unknown" } : { kind: "error", message: String(e) }
      }
    })
  } catch (e) {
    return { kind: "error", message: String(e) }
  } finally {
    if (!closed) await fh.close().catch(() => {})
  }
}

/** The open file's bytes still hash to `base` (and it didn't grow past what was hashed). */
async function sameBytes(fh: fs.promises.FileHandle, base: string | null): Promise<boolean> {
  const st = await fh.stat()
  if (base === null || st.size > FILE_READ_CAP) return false
  // One byte past the size: a file that grew since the stat (an agent appending) is changed.
  const now = Buffer.alloc(st.size + 1)
  let got = 0
  while (got < now.length) {
    const { bytesRead } = await fh.read(now, got, now.length - got, got)
    if (!bytesRead) break
    got += bytesRead
  }
  return got <= st.size && hashBytes(now.subarray(0, got)) === base
}

/** Runs one task per key at a time, in order; a failed task frees its key. */
export class KeyedQueue {
  private tails = new Map<string, Promise<unknown>>()

  run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve()
    const next = prev.then(task, task)
    const tail = next.catch(() => {})
    this.tails.set(key, tail)
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key)
    })
    return next
  }
}

const inodes = new KeyedQueue() // in the save worker: writes of one file, one at a time

// `stuck`: its write may still land, until `done` (its process gone) sets `landed`.
type Slot = { settled: Promise<void>; stuck: boolean; done: Promise<void>; landed: boolean }

const tick = () => new Promise<void>((r) => setTimeout(r, 0))

const STUCK: SaveResult = {
  kind: "error",
  message: "An earlier save of this file is stuck: its disk isn't answering",
}

// Saves of one path run in order. A save whose write may still land (`unknown`: it hung, or its
// worker went) holds the path until its process is gone, and saves after it fail at once rather
// than wait on a dead mount; a process that never exits holds it for the session.
/** Saves of one file, one at a time, never past one that may still land. */
export class SaveLocks {
  private held = new Map<string, Slot>()

  async run(
    key: string,
    save: (track: (ended: Promise<void>) => void) => Promise<SaveResult>,
  ): Promise<SaveResult> {
    const prev = this.held.get(key)
    let settle!: () => void
    const slot: Slot = {
      settled: new Promise((r) => (settle = r)),
      stuck: false,
      done: Promise.resolve(),
      landed: false,
    }
    this.held.set(key, slot)
    try {
      if (prev) await prev.settled
      // A process already gone (a failed write it answered, a crash) lets the path go now.
      if (prev?.stuck && !prev.landed) await Promise.race([prev.done, tick()])
      if (prev?.stuck && !prev.landed) {
        slot.stuck = true // the one before may still land: so may the path, for those after
        slot.done = prev.done.then(() => void (slot.landed = true))
        return STUCK
      }
      const ended: Promise<void>[] = []
      const r = await save((e) => ended.push(e))
      if (r.kind === "unknown") {
        slot.stuck = true
        slot.done = Promise.all(ended).then(() => void (slot.landed = true))
      }
      return r
    } finally {
      settle()
      void slot.done.then(() => {
        if (this.held.get(key) === slot) this.held.delete(key)
      })
    }
  }
}

// A worker failure that surely wrote nothing: no worker to send it to.
const surelyNotWritten = (code: string | undefined) => code === "EBUSY"

/** Save through a path's share forms in turn (WSL), moving on only while nothing was written. */
export async function saveAcross(
  targets: string[],
  write: (target: string) => Promise<SaveResult>,
): Promise<SaveResult> {
  let last: SaveResult = { kind: "missing" }
  let unopened: SaveResult | null = null // a form that has the file but wouldn't open it
  for (const target of targets) {
    try {
      last = await write(target)
    } catch (e) {
      const code = (e as { code?: string }).code
      return surelyNotWritten(code) ? { kind: "error", message: String(e) } : { kind: "unknown" }
    }
    if (last.kind === "error" && last.unopened) unopened ??= last
    else if (last.kind !== "missing") return last
  }
  return unopened ?? last // "missing" only when no form had the file
}

/** The renderer's save request is well-formed: an absolute path, text, a base (or `create`). */
export function validSave(
  p: unknown,
  text: unknown,
  base: unknown,
  create: unknown,
  isAbsolute: (p: string) => boolean,
): p is string {
  return (
    typeof p === "string" &&
    p.length > 0 &&
    !p.includes("\0") &&
    (isAbsolute(p) || p.startsWith("/")) &&
    typeof text === "string" &&
    text.length <= FILE_READ_CAP && // (a UTF-16 unit is at least one UTF-8 byte)
    (base === null || typeof base === "string") &&
    (create === undefined || typeof create === "boolean") &&
    (create === true || typeof base === "string")
  )
}
