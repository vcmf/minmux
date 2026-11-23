// Raw HTML inside markdown (docs/design/MARKDOWN.md, "Safety"): the renderer page can spawn
// processes, so a tag goes out only when it is on a short list and has no attributes (`open` on
// <details> aside), written by us rather than copied. Everything else shows as text; comments
// go. Works on the string alone (no DOM), so it runs in the markdown worker. Pure.
import { escapeHtml } from "./file-preview"
import { safeLink } from "./markdown-links"

const ALLOWED = new Set([
  "details",
  "summary",
  "br",
  "sub",
  "sup",
  "kbd",
  "b",
  "i",
  "em",
  "strong",
  "code",
  "ins",
  "del",
  "hr",
  "p",
])

// A comment (to its end, or the end of the text), a tag, a run of text, or a lone `<`.
const PIECE = /<!--[\s\S]*?(?:-->|$)|<(\/?)([A-Za-z][A-Za-z0-9-]*)([^<>]*)>|[^<]+|</g
const ENTITY = /&amp;(#\d{1,7}|#x[0-9a-f]{1,6}|[a-z][a-z0-9]{1,31});/gi

/** Text, escaped, keeping character references (`&nbsp;`, `&#169;`) as they were. */
const text = (s: string) => escapeHtml(s).replace(ENTITY, "&$1;")

/** One attribute's value from a raw tag's attributes, entities `&amp;` read back. */
function attr(attrs: string, name: string): string {
  const m = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, "i").exec(attrs)
  return (m?.[1] ?? m?.[2] ?? m?.[3] ?? "").replace(/&amp;/g, "&")
}

// GitHub's screenshot drag-and-drop writes <img width=… src=…>: a link to the image, as the
// markdown image rule writes it (images load in a later step), never the tag itself.
/** One tag as we write it, or null when it isn't allowed. */
function tag(closing: boolean, name: string, attrs: string): string | null {
  const n = name.toLowerCase()
  if (n === "img" && !closing) {
    const src = attr(attrs, "src").trim()
    if (!src || !safeLink(src)) return null
    const alt = attr(attrs, "alt") || src
    const s = escapeHtml(src)
    return `<a class="md-img" href="${s}" data-src="${s}">${escapeHtml(alt)}</a>`
  }
  if (!ALLOWED.has(n)) return null
  const a = attrs.trim().replace(/\/$/, "").trim()
  if (!a) return closing ? `</${n}>` : `<${n}>`
  if (!closing && n === "details" && a.toLowerCase() === "open") return "<details open>"
  return null
}

/** Raw HTML from a markdown source, with only the allowed tags left as markup. */
export function cleanHtml(raw: string): string {
  let out = ""
  for (const m of raw.matchAll(PIECE)) {
    const piece = m[0]
    if (piece.startsWith("<!--")) continue
    if (m[2] !== undefined) out += tag(m[1] === "/", m[2], m[3] ?? "") ?? text(piece)
    else out += text(piece)
  }
  return out
}
