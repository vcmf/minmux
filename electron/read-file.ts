// Read a file for its tab (src/lib/file-tab): text up to FILE_READ_CAP (binary sniffed), or an
// image as a data URL. Runs in the fs worker, so a slow or dead mount never stalls main.
import fs from "node:fs"
import { StringDecoder } from "node:string_decoder"
import { classifyPreview } from "../src/lib/file-preview"
import { FILE_READ_CAP, IMAGE_MAX, imageMime, type FileData } from "../src/lib/file-tab"

/** Read `file`; any failure is an error result (never throws). */
export async function readFileForTab(file: string, cap = FILE_READ_CAP): Promise<FileData> {
  try {
    const st = await fs.promises.stat(file)
    if (!st.isFile()) return { kind: "error", message: "Not a file" }
    const size = st.size
    const mime = imageMime(file)
    if (mime) {
      if (size > IMAGE_MAX) return { kind: "too-large", size }
      const buf = await fs.promises.readFile(file)
      return { kind: "image", dataUrl: `data:${mime};base64,${buf.toString("base64")}`, size }
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
    return { kind: "text", text: new StringDecoder("utf8").write(chunk), truncated: false, size }
  } catch (e) {
    const code = (e as { code?: string }).code
    return { kind: "error", message: code === "ENOENT" ? "This file is gone" : String(e) }
  }
}
