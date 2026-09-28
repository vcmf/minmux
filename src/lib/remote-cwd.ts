// The folder a remote shell is in: learnt from what the host prints (display only; nothing
// local ever reads it), and used to put a reconnect, a restore or a split back there.
// Shared by the renderer and main; dependency-free.

import { hasControlChar } from "./control-chars"

const MAX_REMOTE_CWD = 1024

/** A remote folder we'll show and `cd` to: absolute, `~` or `~/…`; no control characters, and
 *  no `!` (csh expands it even inside quotes). null otherwise. */
export function cleanRemoteCwd(v: unknown): string | null {
  if (typeof v !== "string") return null
  const p = v.trim()
  if (!p || p.length > MAX_REMOTE_CWD || hasControlChar(p) || p.includes("!")) return null
  if (p === "~" || p.startsWith("~/") || p.startsWith("/")) return p
  return null
}

/** The folder in an OSC 7 report (`file://host/path`, percent-encoded). */
export function cwdFromOsc7(data: string): string | null {
  try {
    return cleanRemoteCwd(decodeURIComponent(new URL(data).pathname))
  } catch {
    return null
  }
}

/** The folder in a window title in the Debian / Ubuntu bash style `user@host: ~/dir`. */
export function cwdFromTitle(title: string): string | null {
  const m = /^[^\s@:]+@[^\s:]+:\s*(\S.*)$/.exec(title.trim())
  return m ? cleanRemoteCwd(m[1]) : null
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

/** The remote command that opens a login shell in `dir` (ssh hands it to the remote shell). */
export function remoteCdCommand(dir: string): string {
  const quoted = `'${dir.replace(/'/g, `'\\''`)}'`
  return `exec sh -c '${CD_SCRIPT}' smterm ${quoted}`
}

/** What ssh says when the host's config already has a RemoteCommand (ours can't run too). */
export const REMOTE_COMMAND_CONFLICT = "Cannot execute command-line and remote command"
