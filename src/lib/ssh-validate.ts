// Validators shared by settings (renderer) and the ssh argv builders (main). Kept tiny and
// dependency-free so main can import it without pulling in the settings/theme tables.

import type { SshEnv } from "../types"
import { hasControlChar } from "./control-chars"

export { hasControlChar }

// Hostname / user characters only (IPv6 brackets, `%` zone ids): no shell metacharacters,
// which older ssh could pass to a ProxyCommand/Match exec via %h/%r (CVE-2023-51385).
const SSH_TARGET_RE = /^[A-Za-z0-9._@:%+[\]-]+$/

/** An ssh destination safe as argv: host/user characters only, no leading `-`. */
export function isSshTarget(v: unknown): v is string {
  return typeof v === "string" && v.length <= 255 && !v.startsWith("-") && SSH_TARGET_RE.test(v)
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
// -o keywords that likewise stop the pane getting an interactive shell.
const BLOCKED_O = new Set([
  "sessiontype",
  "forkafterauthentication",
  "remotecommand",
  "stdinnull",
  "requesttty",
])

/** The keyword of an `-o` value as ssh reads it: leading blanks/`=` skipped, quotes removed. */
function oKeyword(v: string): string {
  let i = 0
  while (i < v.length && /[ \t=]/.test(v[i]!)) i++
  let kw = ""
  let quote = false
  for (; i < v.length; i++) {
    const c = v[i]!
    if (c === '"') quote = !quote
    else if (!quote && /[ \t=]/.test(c)) break
    else kw += c
  }
  return kw.toLowerCase()
}

/** Walk ssh options, calling `visit(flag, value)`; false if the list isn't valid options. */
function walkSshOptions(
  args: readonly unknown[],
  visit?: (flag: string, value?: string) => void,
): boolean {
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
        let v: unknown
        if (k + 1 < a.length)
          v = a.slice(k + 1) // attached: -p2222
        else v = args[++i] // separate: -p 2222
        if (typeof v !== "string" || hasControlChar(v)) return false
        visit?.(ch, v)
        break
      }
      if (!SSH_FLAGS.has(ch)) return false
      visit?.(ch)
    }
  }
  return true
}

/** Valid ssh options that still open a shell? (A stray word would become the host.) */
export function isSshOptionList(args: readonly unknown[]): boolean {
  let ok = true
  const valid = walkSshOptions(args, (flag, value) => {
    if (flag === "o" && BLOCKED_O.has(oKeyword(value!))) ok = false
  })
  return valid && ok
}

/** Do these args set multiplexing (-M, -S, -o Control*) or their own config file (-F)? */
export function sshArgsSetMux(args: readonly string[] | undefined): boolean {
  let mux = false
  walkSshOptions(args ?? [], (flag, value) => {
    if (flag === "M" || flag === "S" || flag === "F") mux = true
    const kw = flag === "o" ? oKeyword(value!) : ""
    if (kw === "controlmaster" || kw === "controlpath" || kw === "controlpersist") mux = true
  })
  return mux
}

/** A host defined in settings.json (in addition to ~/.ssh/config). */
export interface SshHostSetting {
  name: string // label + stable id
  target: string // ssh destination (alias or user@host)
  args: string[] // extra ssh flags, e.g. ["-p", "2222"]
  env: SshEnv // which ssh runs it ("native", or "wsl:<distro>" on Windows)
}

const MAX_SSH_HOSTS = 500
const MAX_SSH_ARGS = 32

/** One settings host, or null if any part is invalid (dropped whole, never half-kept). */
function sshHostSetting(v: unknown): SshHostSetting | null {
  if (!v || typeof v !== "object") return null
  const o = v as Record<string, unknown>
  const name = typeof o.name === "string" ? o.name.trim() : ""
  if (!name || name.length > 80 || hasControlChar(name)) return null
  if (!isSshTarget(o.target)) return null
  let args: string[] = []
  if (o.args !== undefined) {
    if (!Array.isArray(o.args) || o.args.length > MAX_SSH_ARGS) return null
    if (!isSshOptionList(o.args)) return null
    args = [...(o.args as string[])]
  }
  let env: SshEnv = "native"
  if (o.env !== undefined && o.env !== "native") {
    if (!isSshEnv(o.env)) return null
    env = o.env
  }
  return { name, target: o.target, args, env }
}

/** The usable settings hosts, plus the indexes of rejected entries (for a warning). */
export function validateSshHosts(raw: readonly unknown[]): {
  hosts: SshHostSetting[]
  rejected: number[]
} {
  const hosts: SshHostSetting[] = []
  const rejected: number[] = []
  const names = new Set<string>()
  raw.forEach((entry, i) => {
    const h = i < MAX_SSH_HOSTS ? sshHostSetting(entry) : null
    if (!h || names.has(h.name)) rejected.push(i)
    else {
      names.add(h.name)
      hosts.push(h)
    }
  })
  return { hosts, rejected }
}
