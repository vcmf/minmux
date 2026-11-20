// A file tab (docs/design/WORKDIR_OBJECTS.md, step 3a): what it reads, and which files open in
// one at all (the rest go to the editor or the OS app). Pure.
import type { PreviewData } from "./file-preview"

export const FILE_READ_CAP = 2 * 1024 * 1024 // text read and shown; past it, "open in editor"
export const IMAGE_MAX = 5 * 1024 * 1024 // an image past this isn't read

/** What reading a file for its tab gives. */
export type FileData = PreviewData | { kind: "image"; dataUrl: string; size: number }

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
