// Validators shared by settings (renderer) and the ssh argv builders (main). Kept tiny and
// dependency-free so main can import it without pulling in the settings/theme tables.

import type { SshEnv } from "../types"
import { hasControlChar } from "./control-chars"

export { hasControlChar }

/** An ssh destination safe as argv: no leading `-`, no whitespace or control chars. */
export function isSshTarget(v: unknown): v is string {
  return (
    typeof v === "string" &&
    v.length > 0 &&
    v.length <= 255 &&
    !v.startsWith("-") &&
    !/\s/.test(v) &&
    !hasControlChar(v)
  )
}

// A distro name as `wsl.exe -l -q` prints it (letters, digits, `.`, `-`, `_`).
const WSL_ENV_RE = /^wsl:([A-Za-z0-9._-]+)$/

/** A parsed SshEnv; null for a malformed one. */
export type ParsedSshEnv = { kind: "native" } | { kind: "wsl"; distro: string }

export function parseSshEnv(env: unknown): ParsedSshEnv | null {
  if (env === "native") return { kind: "native" }
  const m = typeof env === "string" ? WSL_ENV_RE.exec(env) : null
  return m ? { kind: "wsl", distro: m[1]! } : null
}

/** Type guard over parseSshEnv. */
export const isSshEnv = (v: unknown): v is SshEnv => parseSshEnv(v) !== null

// ssh(1) options that take a value (OpenSSH's getopt string), and flags, limited to ones
// that still open an interactive shell: -G/-V/-O/-Q print or control, -N/-f/-n/-s/-W
// never give the pane a shell.
const SSH_OPTS_WITH_VALUE = new Set("bceilmopBDEFIJLPRSw")
const SSH_FLAGS = new Set("1246agkqtvxACKMTXYy")

/** Are these valid ssh options (each value present)? A stray word would become the host. */
export function isSshOptionList(args: readonly unknown[]): boolean {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (
      typeof a !== "string" ||
      hasControlChar(a) ||
      a.length < 2 ||
      !a.startsWith("-") ||
      a === "--"
    )
      return false
    for (let k = 1; k < a.length; k++) {
      const ch = a[k]!
      if (SSH_OPTS_WITH_VALUE.has(ch)) {
        if (k + 1 < a.length) break // value attached: -p2222
        const v = args[i + 1]
        if (typeof v !== "string" || hasControlChar(v)) return false
        i++ // value is the next arg: -p 2222
        break
      }
      if (!SSH_FLAGS.has(ch)) return false
    }
  }
  return true
}
