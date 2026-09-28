// The folder a remote shell is in: learnt from what the host prints (display only; nothing
// local ever reads it), and used to put a reconnect, a restore or a split back there.
// Shared by the renderer and main; dependency-free.

import { hasControlChar } from "./control-chars"

const MAX_REMOTE_CWD = 1024

/** A remote folder we'll show: absolute, `~` or `~/…`, no control characters, not a Windows
 *  drive path (`/C:/…` from a PowerShell host), capped. null otherwise. */
export function cleanRemoteCwd(v: unknown): string | null {
  if (typeof v !== "string") return null
  const p = v.trim()
  if (!p || p.length > MAX_REMOTE_CWD || hasControlChar(p)) return null
  if (/^\/[A-Za-z]:([/\\]|$)/.test(p)) return null
  if (p === "~" || p.startsWith("~/") || p.startsWith("/")) return p
  return null
}

// Letters, digits, space and `._-/~+@,:=%#` only. Inside single quotes none of these is special
// in any shell a host might log in with (sh, bash, zsh, fish, csh, even PowerShell), so the
// quoting below can't be broken out of. Anything else (quotes, `\`, `$`, backticks, `;`, `|`,
// `&`, `!`, brackets, globs) is shown but never sent: a reconnect then opens a plain login.
const SAFE_CD = /^[\p{L}\p{N} ._\-/~+@,:=%#]+$/u

/** Whether a (clean) remote folder may be `cd`'d to on reconnect. */
export const safeForCd = (p: string): boolean => cleanRemoteCwd(p) === p && SAFE_CD.test(p)

/** The folder in an OSC 7 report (`file://host/path`, percent-encoded), with the host it
 *  names ("" when none). */
export function cwdFromOsc7(data: string): { host: string; dir: string } | null {
  try {
    const url = new URL(data)
    const dir = cleanRemoteCwd(decodeURIComponent(url.pathname))
    return dir ? { host: url.hostname.toLowerCase(), dir } : null
  } catch {
    return null
  }
}

/** The folder in a window title in the Debian / Ubuntu bash style `user@host: ~/dir`, with
 *  the host. Only a path with no spaces: a title can carry more after it (`/var/log (tail)`). */
export function cwdFromTitle(title: string): { host: string; dir: string } | null {
  const m = /^[^\s@:]+@([^\s:]+):\s*(\S+)$/.exec(title.trim())
  const dir = m ? cleanRemoteCwd(m[2]) : null
  return dir ? { host: m![1]!.toLowerCase(), dir } : null
}

/** A remote folder for a subline: home-relative stays as is; a long path keeps its tail. */
export function shortRemoteCwd(p: string, max = 40): string {
  if (p.length <= max) return p
  const parts = p.split("/")
  let out = parts.pop() ?? p
  while (parts.length && out.length + parts[parts.length - 1]!.length + 1 <= max - 2) {
    out = `${parts.pop()}/${out}`
  }
  return `…/${out}`
}

/** `~/…` for a path under the host user's home (`/home/u`, `/Users/u`, `/root` for root):
 *  OSC 7 reports absolute paths, the Ubuntu-style title home-relative ones. */
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

// Run in `sh` whatever the login shell is (fish, csh…): `$1` is the folder, passed as an
// argument and never spliced into code. A folder that's gone just leaves you at home.
const CD_SCRIPT =
  'case $1 in "~") d=$HOME;; "~/"*) d=$HOME/${1#"~/"};; *) d=$1;; esac; ' +
  'cd -- "$d" 2>/dev/null; exec "$SHELL" -l'

/** The remote command that opens a login shell in `dir` (ssh hands it to the remote shell);
 *  null unless the folder is safeForCd, so it's quoted with nothing inside that could escape. */
export function remoteCdCommand(dir: string): string | null {
  if (!safeForCd(dir)) return null
  return `exec sh -c '${CD_SCRIPT}' smterm '${dir}'`
}

/** What ssh says when the host's config already has a RemoteCommand (ours can't run too). */
export const REMOTE_COMMAND_CONFLICT = "Cannot execute command-line and remote command"
