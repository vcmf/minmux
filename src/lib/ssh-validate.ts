// Validators shared by settings (renderer) and the ssh argv builders (main). Kept tiny and
// dependency-free so main can import it without pulling in the settings/theme tables.

import type { SshEnv } from "../types"

/** Any C0 control character or DEL (would corrupt an argv or an ssh -o value). */
export function hasControlChar(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c < 0x20 || c === 0x7f) return true
  }
  return false
}

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
