// Read a file for its tab (src/lib/file-tab): text up to FILE_READ_CAP (binary sniffed), or an
// image as a data URL. Runs in the fs worker, so a slow or dead mount never stalls main.
import fs from "node:fs"
import { StringDecoder } from "node:string_decoder"
import { classifyPreview } from "../src/lib/file-preview"
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
      if (size > IMAGE_MAX) return { kind: "too-large", size }
      const buf = await fs.promises.readFile(file)
      const dataUrl = `data:${mime};base64,${buf.toString("base64")}`
      return { kind: "image", dataUrl, size, stamp }
    }
    const len = Math.min(size, cap)
    const buf = Buffer.alloc(len)
    let bytesRead = 0
    const fh = await fs.promises.open(file, "r")
    try {
      if (len > 0) ({ bytesRead } = await fh.read(buf, 0, len, 0))
    } finally {
      await fh.close()
    }
    const chunk = buf.subarray(0, bytesRead)
    const meta = classifyPreview(size, bytesRead, chunk.includes(0))
    if (meta.kind === "binary") return { kind: "binary", size }
    // A text file past the cap: the editor shows it whole.
    if (meta.truncated) return { kind: "too-large", size }
    const text = new StringDecoder("utf8").write(chunk)
    return { kind: "text", text, truncated: false, size, stamp }
  } catch (e) {
    const code = (e as { code?: string }).code
    return { kind: "error", message: code === "ENOENT" ? "This file is gone" : String(e) }
  }
}
