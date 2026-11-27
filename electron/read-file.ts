// Read a file for its tab (src/lib/file-tab): text up to FILE_READ_CAP (binary sniffed), or an
// image as a data URL. Runs in the fs worker, so a slow or dead mount never stalls main.
import { createHash } from "node:crypto"
import fs from "node:fs"
import {
  FILE_READ_CAP,
  IMAGE_MAX,
  imageMime,
  sameStamp,
  type FileData,
  type FileStamp,
} from "../src/lib/file-tab"

/** A file's bytes as an editor's base: a save writes only over the bytes it was edited from. */
export const hashBytes = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex")

// Invalid UTF-8 decodes to U+FFFD, so only text holding one needs the full check.
/** The text encodes back to the bytes it was decoded from. */
export const losslessUtf8 = (text: string, bytes: Uint8Array): boolean =>
  !text.includes("\uFFFD") || Buffer.from(text, "utf8").equals(bytes)

/** Read `file` (not when it still matches `since`); any failure is an error (never throws). */
export async function readFileForTab(
  file: string,
  cap = FILE_READ_CAP,
  since?: FileStamp,
): Promise<FileData> {
  try {
    const st = await fs.promises.stat(file)
    if (!st.isFile()) return { kind: "error", message: "Not a file" }
    const size = st.size
    const stamp: FileStamp = { size, mtimeMs: st.mtimeMs, ctimeMs: st.ctimeMs, ino: st.ino }
    if (since && sameStamp(since, stamp, Date.now())) return { kind: "same" }
    const mime = imageMime(file)
    if (mime) {
      if (size > IMAGE_MAX) return { kind: "too-large", size, stamp }
      const buf = await fs.promises.readFile(file)
      const dataUrl = `data:${mime};base64,${buf.toString("base64")}`
      return { kind: "image", dataUrl, size, stamp }
    }
    // Too large by its size, before any read: an editor shows it whole (and a re-read of it,
    // stamped, is skipped while it doesn't change).
    if (size > cap) return { kind: "too-large", size, stamp }
    const len = size
    const buf = Buffer.alloc(len)
    let bytesRead = 0
    const fh = await fs.promises.open(file, "r")
    try {
      // One read may return less (a network share): read on to the size, or the end.
      while (bytesRead < len) {
        const r = await fh.read(buf, bytesRead, len - bytesRead, bytesRead)
        if (!r.bytesRead) break
        bytesRead += r.bytesRead
      }
    } finally {
      await fh.close()
    }
    // What was read (a file truncated since the stat, being rewritten, is shown as it is now).
    const chunk = buf.subarray(0, bytesRead)
    if (chunk.includes(0)) return { kind: "binary", size, stamp }
    // A last character cut short (being written) shows as �, never silently dropped.
    const text = chunk.toString("utf8")
    const hash = hashBytes(chunk)
    const editable = losslessUtf8(text, chunk)
    return { kind: "text", text, truncated: false, size, stamp, hash, editable }
  } catch (e) {
    const code = (e as { code?: string }).code
    if (code === "ENOENT") return { kind: "error", message: "This file is gone", gone: true }
    return { kind: "error", message: String(e) }
  }
}
