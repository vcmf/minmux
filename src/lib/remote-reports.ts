// Reports from an integrated remote shell (docs/design/SSH_REMOTES.md §8): OSC 6973 carrying
// the connection's nonce, which only our hooks there know. Pure — unit-tested.

import { cwdFromOsc7 } from "./remote-cwd"

/** The private OSC code the remote hooks and the bootstrap use (xterm ignores unknown codes). */
export const SMTERM_OSC = 6973

export type RemoteReport =
  | { kind: "start" } // a command started (OSC 133;C's twin)
  | { kind: "end"; code: number } // …and finished, back at the prompt (133;D)
  | { kind: "cwd"; host: string; dir: string } // the folder the shell is in (OSC 7's)

const NONCE = /^[0-9a-f]{32}$/

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
  if (rest.startsWith("7;")) {
    const at = cwdFromOsc7(rest.slice(2))
    return at ? { kind: "cwd", ...at } : null
  }
  return null
}
