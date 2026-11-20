// A file tab (docs/design/WORKDIR_OBJECTS.md, step 3a): what it reads, and which files open in
// one at all (the rest go to the editor or the OS app). Pure.
import type { PreviewData } from "./file-preview"

export const FILE_READ_CAP = 2 * 1024 * 1024 // text read and shown; past it, "open in editor"
export const IMAGE_MAX = 5 * 1024 * 1024 // an image past this isn't read

/** A read's stamp: a re-read with the same one is skipped (the file didn't change). */
export interface FileStamp {
  size: number
  mtimeMs: number
  ctimeMs?: number
  ino?: number
}

// FAT / exFAT keep modified times to 2 s, HFS+ and many shares to 1 s: an edit that keeps the size
// within that tick looks unchanged. Such a stamp is trusted only once the file's this old.
const COARSE_MS = 2500

/** A stamp that still describes the file now: the read can be skipped. */
export function sameStamp(a: FileStamp, b: FileStamp, now: number): boolean {
  if (a.size !== b.size || a.mtimeMs !== b.mtimeMs) return false
  if (a.ctimeMs !== b.ctimeMs || a.ino !== b.ino) return false
  const coarse = b.mtimeMs % 1000 === 0
  return !coarse || now - b.mtimeMs > COARSE_MS
}

/** What reading a file for its tab gives; `same` when it matches the stamp it was asked with. */
export type FileData =
  | ((PreviewData | { kind: "image"; dataUrl: string; size: number }) & { stamp?: FileStamp })
  | { kind: "same" }

const IMAGES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  ico: "image/x-icon",
  avif: "image/avif",
}

// Never text: documents, media, archives, binaries. They open in their own app.
const OUTSIDE = new Set(
  (
    "pdf doc docx xls xlsx ppt pptx key numbers pages odt ods odp rtf epub " +
    "mp3 mp4 m4a m4v mov avi mkv webm wav flac ogg aac " +
    "zip tar gz tgz bz2 xz 7z rar dmg pkg iso " +
    "exe dll so dylib a o class jar app msi deb rpm wasm bin " +
    "psd ai sketch fig heic tiff tif ttf otf woff woff2 sqlite db"
  ).split(" "),
)

const ext = (p: string) => {
  const name = p.split(/[\\/]/).pop() ?? ""
  const i = name.lastIndexOf(".")
  return i > 0 ? name.slice(i + 1).toLowerCase() : ""
}

/** The image type of a file minmux shows as a picture, if it is one. */
export const imageMime = (p: string): string | undefined => IMAGES[ext(p)]

/** Opens in a file tab: text (sniffed when read) or an image; not a known document or binary. */
export const opensInTab = (p: string): boolean => !OUTSIDE.has(ext(p))
