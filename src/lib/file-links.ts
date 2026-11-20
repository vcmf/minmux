// Detect file-path tokens in terminal output so they can be made clickable.
// Pure — heavily unit-tested. The regex stays permissive on purpose; the real
// false-positive filter is existence validation against the session cwd (done in
// main). Forward-slash paths only for now (mac / Linux / WSL-style); Windows-native
// backslash paths and wrapped-across-rows paths are follow-ups.

export interface FileLinkMatch {
  start: number // 0-based char offset of the clickable span in the line
  length: number // clickable span length (covers path + any :line:col)
  path: string // the file path (without the :line:col suffix)
  line?: number
  col?: number
}

// A run of path-ish characters. Permissive — validation prunes non-files. The
// start class includes `/` `.` `~` so absolute/relative/home paths match from
// their real first char.
const CANDIDATE = /[A-Za-z0-9._~@/][A-Za-z0-9._/~@+-]*(?::\d+(?::\d+)?)?/g
const TRAILING = /[.,;:!?)\]}'"]+$/ // sentence/wrapper punctuation, not part of the path
const LINE_COL = /:(\d+)(?::(\d+))?$/
const VERSION = /^v?\d+(?:\.\d+)+$/ // 1.2.3 / v2.0.1 — a version, not a file
const HAS_EXT = /\.[A-Za-z0-9]{1,10}$/

/** Find path-like tokens (with optional :line:col) in one line of terminal text. */
export function findFilePaths(text: string): FileLinkMatch[] {
  const out: FileLinkMatch[] = []
  for (const m of text.matchAll(CANDIDATE)) {
    const start = m.index ?? 0
    // Skip continuations of a URL or an already-scanned path (prev char ':' or '/').
    const prev = start > 0 ? text[start - 1] : ""
    if (prev === ":" || prev === "/") continue

    let token = m[0]
    const trail = TRAILING.exec(token)
    if (trail) token = token.slice(0, trail.index)
    if (!token) continue

    const length = token.length // clickable span includes the :line:col suffix
    let path = token
    let line: number | undefined
    let col: number | undefined
    const lc = LINE_COL.exec(token)
    if (lc) {
      line = Number(lc[1])
      col = lc[2] ? Number(lc[2]) : undefined
      path = token.slice(0, lc.index)
    }

    // Qualify: must look like a path (has a slash) or a file (has an extension),
    // and not be a bare version/decimal.
    if (!path.includes("/") && !HAS_EXT.test(path)) continue
    if (VERSION.test(path)) continue
    if (!/[A-Za-z0-9]/.test(path)) continue // just separators (e.g. "/", "..", "~")

    out.push({ start, length, path, line, col })
  }
  return out
}

/** A clicked path as an absolute one: `~/` from `home`, a relative one from the terminal's `cwd`,
 *  `.` and `..` resolved. (Forward slashes, as the paths found here.) */
export function resolveLinkPath(cwd: string, p: string, home: string): string {
  const raw =
    p.startsWith("~/") && home ? `${home}${p.slice(1)}` : p.startsWith("/") ? p : `${cwd}/${p}`
  const out: string[] = []
  for (const part of raw.split("/")) {
    if (part === "" || part === ".") continue
    if (part === "..") out.pop()
    else out.push(part)
  }
  return `/${out.join("/")}`
}
