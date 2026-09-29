// Reports from an integrated remote shell (docs/design/SSH_REMOTES.md §8): OSC 6973 carrying
// the connection's nonce, which only our hooks there know. Pure — unit-tested.

import { hasControlChar } from "./control-chars"
import { hasFormatChar } from "./remote-cwd"
import type { Session } from "../types"

/** The private OSC code the remote hooks and the bootstrap use (xterm ignores unknown codes). */
export const MINMUX_OSC = 6973

export type RemoteReport =
  | { kind: "start" } // a command started (OSC 133;C's twin)
  | { kind: "end"; code: number } // …and finished, back at the prompt (133;D)
  // The shell's folder, exactly as it has it; dir null = it moved somewhere we won't show or
  // reopen (so the old folder must go too).
  | { kind: "cwd"; host: string; dir: string | null }

const NONCE = /^[0-9a-f]{32}$/
const HOSTNAME = /^[A-Za-z0-9._-]{1,253}$/
const MAX_DIR = 1024
const utf8 = new TextDecoder("utf-8", { fatal: true })

/** A folder we'd show and reopen: absolute, no control or format characters, no `.` / `..`
 *  segments, capped. Shared by the report parser, the saved workspace and main's handshake. */
export function isReopenable(dir: unknown): dir is string {
  if (typeof dir !== "string" || !dir.startsWith("/") || dir.length > MAX_DIR) return false
  if (hasControlChar(dir) || hasFormatChar(dir)) return false
  return !dir.split("/").some((seg) => seg === "." || seg === "..")
}

/** A hostname as the hooks report it ($HOST / $HOSTNAME), lowercased; "" if it isn't one. */
export const reportedHost = (v: unknown): string =>
  typeof v === "string" && HOSTNAME.test(v) ? v.toLowerCase() : ""

/** A folder from the hooks' hex (each byte of $PWD): valid UTF-8 and isReopenable. Never
 *  "repaired": null otherwise. */
export function folderFromHex(hex: string): string | null {
  if (!hex || hex.length % 2 || hex.length > MAX_DIR * 2 * 4 || /[^0-9a-f]/.test(hex)) return null
  let dir: string
  try {
    dir = utf8.decode(Uint8Array.from(hex.match(/../g)!, (b) => parseInt(b, 16)))
  } catch {
    return null
  }
  return isReopenable(dir) ? dir : null
}

/** Where a new connection should open: a verified folder and the host that reported it. */
export interface ReopenCwd {
  dir: string
  host: string
}

/** A ReopenCwd from anywhere untrusted (a saved workspace, the renderer), validated. */
export function parseReopen(v: unknown): ReopenCwd | undefined {
  if (!v || typeof v !== "object") return undefined
  const { dir, host } = v as Record<string, unknown>
  const h = reportedHost(host)
  return isReopenable(dir) && h ? { dir, host: h } : undefined
}

/** A report this connection's shell sent, or null (another nonce, the bootstrap's own marks,
 *  anything malformed). */
export function parseRemoteReport(data: string, nonce: string | undefined): RemoteReport | null {
  if (!nonce || !NONCE.test(nonce)) return null
  if (data.length < nonce.length + 2 || data.slice(0, nonce.length + 1) !== `${nonce};`) {
    return null
  }
  const rest = data.slice(nonce.length + 1)
  if (rest === "C") return { kind: "start" }
  const end = /^D;(\d{1,3})$/.exec(rest)
  if (end) return { kind: "end", code: Number(end[1]) }
  const cwd = /^P;([^;]*);([^;]*)$/.exec(rest)
  if (cwd) {
    return { kind: "cwd", host: reportedHost(cwd[1]), dir: folderFromHex(cwd[2]!) }
  }
  return null
}

/** Where a new connection of `s` (or a split of it) should open: the folder its shell
 *  verifiably reported, else the one it was given to reopen. Never an unverified folder. */
export function reopenFor(s: Session | undefined): ReopenCwd | undefined {
  if (!s?.remote) return undefined
  if (s.remoteCwdVerified && s.remoteCwd && s.remoteCwdHost) {
    return parseReopen({ dir: s.remoteCwd, host: s.remoteCwdHost })
  }
  return parseReopen(s.reopenCwd)
}
