// Reports from an integrated remote shell (docs/design/SSH_REMOTES.md §8): OSC 6973 carrying
// the connection's nonce, which only our hooks there know. Pure — unit-tested.

import { hasControlChar } from "./control-chars"
import { hasFormatChar } from "./remote-cwd"

/** The private OSC code the remote hooks and the bootstrap use (xterm ignores unknown codes). */
export const SMTERM_OSC = 6973

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

/** A folder from the hooks' hex (each byte of $PWD): valid UTF-8, absolute, no control or
 *  format characters, no `.` / `..` segments, capped. Never "repaired": null otherwise. */
export function folderFromHex(hex: string): string | null {
  if (!hex || hex.length % 2 || hex.length > MAX_DIR * 2 * 4 || /[^0-9a-f]/.test(hex)) return null
  let dir: string
  try {
    dir = utf8.decode(Uint8Array.from(hex.match(/../g)!, (b) => parseInt(b, 16)))
  } catch {
    return null
  }
  if (!dir.startsWith("/") || dir.length > MAX_DIR) return null
  if (hasControlChar(dir) || hasFormatChar(dir)) return null
  if (dir.split("/").some((seg) => seg === "." || seg === "..")) return null
  return dir
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
    const host = HOSTNAME.test(cwd[1]!) ? cwd[1]!.toLowerCase() : ""
    return { kind: "cwd", host, dir: folderFromHex(cwd[2]!) }
  }
  return null
}
