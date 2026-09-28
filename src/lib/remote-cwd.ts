// The folder a remote shell is in, learnt from what the host prints: display only. Nothing
// local reads it, and nothing is ever sent back to the host from it (see SSH_UX.md §8, H2).

import { hasControlChar } from "./control-chars"

const MAX_REMOTE_CWD = 1024

// Bidi controls, zero-width and other format characters: they'd let printed text spoof the
// folder a row shows (U+202E reverses what follows).
const FORMAT_CHARS = /[\p{Cf}\u0080-\u009f\u2028\u2029]/u

/** A remote folder to show: absolute, `~` or `~/…`, no control or format characters, not a
 *  Windows drive path (`/C:/…`), capped; else null. */
export function cleanRemoteCwd(v: unknown): string | null {
  if (typeof v !== "string") return null
  const p = v.trim()
  if (!p || p.length > MAX_REMOTE_CWD || hasControlChar(p) || FORMAT_CHARS.test(p)) return null
  if (/^\/[A-Za-z]:([/\\]|$)/.test(p)) return null
  if (p === "~" || p.startsWith("~/") || p.startsWith("/")) return p
  return null
}

/** The folder in an OSC 7 report (`file://host/path`, percent-encoded), with its host. */
export function cwdFromOsc7(data: string): { host: string; dir: string } | null {
  try {
    const url = new URL(data)
    const dir = cleanRemoteCwd(decodeURIComponent(url.pathname))
    return dir ? { host: url.hostname.toLowerCase(), dir } : null
  } catch {
    return null
  }
}

/** The folder in a Debian / Ubuntu bash title `user@host: ~/dir` (a path with no spaces:
 *  a title can carry more after it). */
export function cwdFromTitle(title: string): { host: string; dir: string } | null {
  const m = /^[^\s@:]+@([^\s:]+):\s*(\S+)$/.exec(title.trim())
  const dir = m ? cleanRemoteCwd(m[2]) : null
  return dir ? { host: m![1]!.toLowerCase(), dir } : null
}

/** Whether two folder reports name the same machine: a title's `\h` is the short hostname,
 *  OSC 7 often the full one, so only the first label is compared. */
export function sameMachine(a: string, b: string): boolean {
  return a.split(".")[0] === b.split(".")[0]
}

/** A remote folder for a subline: a long path keeps its tail (the folder is what matters). */
export function shortRemoteCwd(p: string, max = 40): string {
  if (p.length <= max) return p
  const parts = p.split("/")
  let out = parts.pop() ?? p
  while (parts.length && out.length + parts[parts.length - 1]!.length + 1 <= max - 2) {
    out = `${parts.pop()}/${out}`
  }
  return `…/${out}`
}

/** `~/…` for a path under the host user's home (`/home/u`, `/Users/u`, `/root` for root). */
export function homeRelative(p: string, user?: string): string {
  if (!user || p.startsWith("~")) return p
  const homes = user === "root" ? ["/root"] : [`/home/${user}`, `/Users/${user}`]
  for (const h of homes) {
    if (p === h) return "~"
    if (p.startsWith(`${h}/`)) return `~${p.slice(h.length)}`
  }
  return p
}

/** The user part of a host's `user@hostname:port` detail, if it has one. */
export const detailUser = (detail?: string): string | undefined =>
  detail?.includes("@") ? detail.slice(0, detail.indexOf("@")) : undefined

/** The folder's last segment, a pane row's title ("~" for home). */
export function remoteCwdName(p: string): string {
  if (p === "~" || p === "/") return p
  return p.replace(/\/+$/, "").split("/").pop() || p
}
