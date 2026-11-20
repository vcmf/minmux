// Read a file for its tab (src/lib/file-tab): text up to FILE_READ_CAP (binary sniffed), or an
// image as a data URL. Runs in the fs worker, so a slow or dead mount never stalls main.
import fs from "node:fs"
import { StringDecoder } from "node:string_decoder"
import {
  FILE_READ_CAP,
  IMAGE_MAX,
  imageMime,
  type FileData,
  type FileStamp,
} from "../src/lib/file-tab"

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
    const stamp = { size, mtimeMs: st.mtimeMs }
    if (since && since.size === size && since.mtimeMs === st.mtimeMs) return { kind: "same" }
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
      if (len > 0) ({ bytesRead } = await fh.read(buf, 0, len, 0))
    } finally {
      await fh.close()
    }
    // What was read (a file truncated since the stat, being rewritten, is shown as it is now).
    const chunk = buf.subarray(0, bytesRead)
    if (chunk.includes(0)) return { kind: "binary", size, stamp }
    const text = new StringDecoder("utf8").write(chunk)
    return { kind: "text", text, truncated: false, size, stamp }
  } catch (e) {
    const code = (e as { code?: string }).code
    return { kind: "error", message: code === "ENOENT" ? "This file is gone" : String(e) }
  }
}
