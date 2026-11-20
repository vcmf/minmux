// Highlighted HTML (highlight.js: escaped text and nested <span class="…">) split into one HTML
// string per source line. A span crossing a line break (a block comment, a template string) is
// closed at the end of each line and opened again on the next, so every line renders alone
// with the right colours: the line view renders only the lines in view. Pure.

/** One HTML string per line of the source `html` was made from. */
export function splitHighlighted(html: string): string[] {
  const lines: string[] = []
  const open: string[] = [] // the open span tags, outermost first
  let cur = ""
  const re = /(<span[^>]*>)|(<\/span>)|([^<]+)/g
  for (const m of html.matchAll(re)) {
    if (m[1]) {
      open.push(m[1])
      cur += m[1]
    } else if (m[2]) {
      open.pop()
      cur += m[2]
    } else {
      const parts = m[3]!.split("\n")
      parts.forEach((part, i) => {
        if (i > 0) {
          lines.push(cur + "</span>".repeat(open.length))
          cur = open.join("")
        }
        cur += part
      })
    }
  }
  lines.push(cur + "</span>".repeat(open.length))
  return lines
}
