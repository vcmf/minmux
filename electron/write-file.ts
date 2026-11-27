// Save an edited file (docs/design/FILE_EDITING.md, "Saving"). Runs in the fs worker, so a slow
// or dead mount never stalls main. Writes only over the bytes the editor started from (its
// base hash), in place: the file keeps its inode, owner, mode, hard links, and a symlink stays
// a symlink.
import fs from "node:fs"
import { FILE_READ_CAP, type SaveResult } from "../src/lib/file-tab"
import { hashBytes } from "./read-file"

/** Write `text` (UTF-8) over `file` when its bytes still hash to `base`; with `create`, only
 *  where no file is (a file deleted while edited). Never throws. */
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
    return { kind: "error", message: String(e) }
  }
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
    while (put < bytes.length) {
      const { bytesWritten } = await fh.write(bytes, put, bytes.length - put, put)
      put += bytesWritten
    }
    await fh.truncate(bytes.length)
    const after = await fh.stat()
    return {
      kind: "saved",
      stamp: { size: after.size, mtimeMs: after.mtimeMs, ctimeMs: after.ctimeMs, ino: after.ino },
      hash: hashBytes(bytes),
    }
  } catch (e) {
    return { kind: "error", message: String(e) }
  } finally {
    await fh.close().catch(() => {})
  }
}

/** A worker failure for a write: it may have landed (hung, worker lost, stranded) or surely
 *  didn't (never started: too many stuck workers). */
const surelyNotWritten = (code: string | undefined) => code === "EBUSY"

/** Save through each share form of a path in turn (a WSL file: `\\wsl.localhost`, `\\wsl$`):
 *  the next one only when there's no file at this one. Once a write may have landed, stop. */
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
    if (last.kind !== "missing") return last
  }
  return last
}

/** The renderer's save request, checked: a path main can write, text and a base it sent. */
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
