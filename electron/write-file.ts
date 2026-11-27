// Save an edited file (docs/design/FILE_EDITING.md, "Saving"). Runs in the fs worker, so a slow
// or dead mount never stalls main. Writes only over the bytes the editor started from (its
// base hash), in place: the file keeps its inode, owner, mode, hard links, and a symlink stays
// a symlink.
import fs from "node:fs"
import { FILE_READ_CAP, type SaveResult } from "../src/lib/file-tab"
import { hashBytes } from "./read-file"

/** Write `text` over `file` if its bytes still hash to `base` (`create`: only where none is). */
export async function writeFileForTab(
  file: string,
  text: string,
  base: string | null,
  create = false,
): Promise<SaveResult> {
  const bytes = Buffer.from(text, "utf8")
  if (bytes.length > FILE_READ_CAP) return { kind: "error", message: "Too large to save" }
  let fh: fs.promises.FileHandle
  try {
    // `wx` fails if a file appeared meanwhile: then it's someone else's, not ours to replace.
    fh = await fs.promises.open(file, create ? "wx" : "r+")
  } catch (e) {
    const code = (e as { code?: string }).code
    if (code === "ENOENT") return { kind: "missing" }
    if (code === "EEXIST") return { kind: "changed" }
    return { kind: "error", message: String(e), unopened: true } // another share form may open
  }
  let wrote = false // from the first write on, a failure may have left the file half written
  try {
    const st = await fh.stat()
    if (!st.isFile()) return { kind: "error", message: "Not a file" }
    if (!create) {
      if (base === null || st.size > FILE_READ_CAP) return { kind: "changed" }
      const now = Buffer.alloc(st.size)
      let got = 0
      while (got < now.length) {
        const { bytesRead } = await fh.read(now, got, now.length - got, got)
        if (!bytesRead) break // shrank since the stat: hashed as it is now
        got += bytesRead
      }
      if (hashBytes(now.subarray(0, got)) !== base) return { kind: "changed" }
    }
    // Write first, then cut to length: the file never reads empty in between.
    let put = 0
    wrote = true
    while (put < bytes.length) {
      const { bytesWritten } = await fh.write(bytes, put, bytes.length - put, put)
      put += bytesWritten
    }
    await fh.truncate(bytes.length) // (an empty text: no write above, the truncate is the write)
    const after = await fh.stat()
    return {
      kind: "saved",
      stamp: { size: after.size, mtimeMs: after.mtimeMs, ctimeMs: after.ctimeMs, ino: after.ino },
      hash: hashBytes(bytes),
    }
  } catch (e) {
    return wrote ? { kind: "unknown" } : { kind: "error", message: String(e) }
  } finally {
    await fh.close().catch(() => {})
  }
}

// A worker failure that surely wrote nothing: no worker to send it to, or a stuck save before it.
const surelyNotWritten = (code: string | undefined) => code === "EBUSY"

/** Save through a path's share forms in turn (WSL), moving on only while nothing was written. */
export async function saveAcross(
  targets: string[],
  write: (target: string) => Promise<SaveResult>,
): Promise<SaveResult> {
  let last: SaveResult = { kind: "missing" }
  for (const target of targets) {
    try {
      last = await write(target)
    } catch (e) {
      const code = (e as { code?: string }).code
      return surelyNotWritten(code) ? { kind: "error", message: String(e) } : { kind: "unknown" }
    }
    // No file there, or it wouldn't open (as a read moves on, on any error): the next form.
    if (last.kind !== "missing" && !(last.kind === "error" && last.unopened)) return last
  }
  return last
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
    (base === null || typeof base === "string") &&
    (create === undefined || typeof create === "boolean") &&
    (create === true || typeof base === "string")
  )
}
