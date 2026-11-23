// Where a link in a rendered markdown file goes (docs/design/MARKDOWN.md, "Safety" 2): the web
// and mail through the OS, a relative path as a tab in the same pane (the WORKDIR_OBJECTS rule),
// `#heading` within the view. Pure.

/** A clicked link's target; null when it goes nowhere (a scheme we don't open). */
export type LinkTarget =
  | { kind: "external"; url: string }
  | { kind: "anchor"; anchor: string }
  | { kind: "file" | "folder"; path: string; anchor?: string }
  | null

const decode = (s: string) => {
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}

/** `rel` from `dir` (`.` and `..` resolved; never above the root), in `dir`'s separator. */
export function joinPath(dir: string, rel: string): string {
  const sep = dir.includes("\\") && !dir.includes("/") ? "\\" : "/"
  const parts = dir.split(/[\\/]/).filter((p, i) => p || i === 0)
  const min = 1 // the root ("" for `/`, `C:` on Windows) stays
  for (const seg of rel.split(/[\\/]/)) {
    if (!seg || seg === ".") continue
    if (seg === "..") {
      if (parts.length > min) parts.pop()
    } else parts.push(seg)
  }
  const out = parts.join(sep)
  return out || sep
}

/** Where `href` (as the renderer wrote it) goes from a file in `dir`; `/x` is from `root`. */
export function linkTarget(href: string, dir: string, root?: string): LinkTarget {
  const h = href.trim()
  if (!h) return null
  if (h.startsWith("#")) return { kind: "anchor", anchor: decode(h.slice(1)) }
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(h)
  if (scheme) return /^(?:https?|mailto)$/i.test(scheme[1]!) ? { kind: "external", url: h } : null
  const hash = h.indexOf("#")
  const pathPart = (hash < 0 ? h : h.slice(0, hash)).replace(/\?.*$/, "")
  const anchor = hash < 0 ? undefined : decode(h.slice(hash + 1)) || undefined
  const rel = decode(pathPart)
  const path = rel.startsWith("/") ? joinPath(root ?? dir, rel) : joinPath(dir, rel)
  const kind = /[\\/]$/.test(rel) ? "folder" : "file"
  return { kind, path, ...(anchor ? { anchor } : {}) }
}
