// SSH remotes: the saved-host list and the exact argv a remote session spawns with
// (SSH_REMOTES.md §3–§5). Pure — main supplies the platform, the ssh binary and the
// ControlMaster dir. A RemoteRef from the renderer is untrusted: trustedRemote() rebuilds
// it from main's own host list before anything is spawned.

import path from "node:path"
import type { RemoteRef, SshEnv, SshHost } from "../src/types"
import type { SshSettings } from "../src/settings/schema"
import { hasControlChar, isSshTarget, parseSshEnv } from "../src/lib/ssh-validate"
import type { PlatformPath, SshConfigHost } from "./ssh-config"

/** The sidebar subline for a config host: `user@hostname:port` (parts that are set). */
export function hostDetail(h: SshConfigHost): string | undefined {
  const host = h.hostName ?? (h.user ? h.alias : undefined)
  if (!host) return undefined
  const port = h.port && h.port !== "22" ? `:${h.port}` : ""
  return `${h.user ? `${h.user}@` : ""}${host}${port}`
}

export interface MergeInput {
  native: SshConfigHost[] // ~/.ssh/config (+ Includes) on this machine
  wsl: [distro: string, hosts: SshConfigHost[]][] // each distro's config, in distro order
  settings: SshSettings
}

/** Config hosts (native, then per WSL distro) + settings hosts; hidden filtered, ids unique. */
export function mergeHosts({ native, wsl, settings }: MergeInput): SshHost[] {
  const hidden = new Set(settings.hidden)
  const out: SshHost[] = []
  const ids = new Set<string>()
  const add = (h: SshHost) => {
    if (ids.has(h.hostId)) return
    ids.add(h.hostId)
    out.push(h)
  }
  const fromConfig = (h: SshConfigHost, env: SshEnv, idPrefix: string): SshHost => {
    const detail = hostDetail(h)
    return {
      hostId: `${idPrefix}:${h.alias}`,
      label: h.alias,
      target: h.alias,
      env,
      source: "config",
      ...(detail ? { detail } : {}),
    }
  }
  if (settings.fromSshConfig) {
    // A config alias is only listed if it's safe as an ssh argv destination.
    const listable = (h: SshConfigHost) => !hidden.has(h.alias) && isSshTarget(h.alias)
    for (const h of native) if (listable(h)) add(fromConfig(h, "native", "native"))
    for (const [distro, hosts] of wsl) {
      if (!parseSshEnv(`wsl:${distro}`)) continue
      for (const h of hosts) if (listable(h)) add(fromConfig(h, `wsl:${distro}`, `wsl:${distro}`))
    }
  }
  for (const s of settings.hosts) {
    if (hidden.has(s.name)) continue
    add({
      hostId: `settings:${s.name}`,
      label: s.name,
      target: s.target,
      env: s.env,
      source: "settings",
      ...(s.args.length ? { extraArgs: [...s.args] } : {}),
      ...(s.target !== s.name ? { detail: s.target } : {}),
    })
  }
  return out
}

export const CONTROL_PERSIST = "10m"
// sun_path is 104 bytes on macOS/BSD and 108 on Linux, NUL included: stay within 103.
const SOCKET_PATH_MAX = 103
// `%C` expands to 40 hex chars, and while creating the master ssh binds a temp name
// `<path>.<16 random chars>` first: "/" + 40 + "." + 16.
const CONTROL_NAME_BYTES = 1 + 40 + 1 + 16

/** Does a ControlMaster socket in `dir` stay under the unix socket path limit? */
export function controlPathFits(dir: string): boolean {
  return new TextEncoder().encode(dir).length + CONTROL_NAME_BYTES <= SOCKET_PATH_MAX
}

/** ~/.config/smterm/cm, or /tmp/smterm-<uid> for a long home (caller checks ownership). */
export function controlDir(home: string, uid: number, p: PlatformPath = path.posix): string {
  const primary = p.join(home, ".config", "smterm", "cm")
  return controlPathFits(primary) ? primary : `/tmp/smterm-${uid}`
}

/** lstat-like facts about a candidate control dir. */
export interface DirFacts {
  isDirectory: boolean
  isSymbolicLink: boolean
  uid: number
  mode: number
}

/** A real dir we own that nobody else can enter (else they could hijack our sockets). */
export function isSafeControlDir(st: DirFacts, uid: number): boolean {
  return st.isDirectory && !st.isSymbolicLink && st.uid === uid && (st.mode & 0o077) === 0
}

/** ControlMaster flags for sockets in `dir` (quoted, `%` → `%%`); [] if it can't be quoted. */
export function reuseFlags(dir: string): string[] {
  if (dir.includes('"') || hasControlChar(dir)) return []
  const controlPath = `${dir.replace(/%/g, "%%")}/%C`
  return [
    "-o",
    "ControlMaster=auto",
    "-o",
    `ControlPath="${controlPath}"`,
    "-o",
    `ControlPersist=${CONTROL_PERSIST}`,
  ]
}

// Runs INSIDE a WSL distro as `sh -c SCRIPT smterm-ssh <target> <extra args…>`: picks the
// control dir there (short home → ~/.config/smterm/cm, else /tmp/smterm-<uid>), creates it
// 0700, and adds the ControlMaster flags only for a real dir we own — after the user's own
// args, so theirs win. Any doubt → plain ssh. One line (`;`-joined) so it crosses
// wsl.exe's command line intact.
export const WSL_SSH_SCRIPT = [
  't="$1"; shift',
  'd="$HOME/.config/smterm/cm"',
  `[ $((\${#d} + ${CONTROL_NAME_BYTES})) -le ${SOCKET_PATH_MAX} ] || d="/tmp/smterm-$(id -u)"`,
  'case "$d" in *[%\\"]*) exec ssh "$@" -t -- "$t";; esac',
  'mkdir -p "$d" 2>/dev/null && chmod 700 "$d" 2>/dev/null',
  'if [ -d "$d" ] && [ ! -L "$d" ] && [ -O "$d" ]; then' +
    ` exec ssh "$@" -o ControlMaster=auto -o "ControlPath=\\"$d/%C\\"" -o ControlPersist=${CONTROL_PERSIST} -t -- "$t"; fi`,
  'exec ssh "$@" -t -- "$t"',
].join("; ")

export interface SpawnContext {
  platform: NodeJS.Platform
  sshPath: string // native ssh binary (`ssh`, or the resolved ssh.exe on Windows)
  controlDir: string | null // a verified-safe native control dir; null = no native reuse
  reuse: boolean // settings.ssh.reuseConnections
}

/** node-pty file + args for a remote session; null if this platform can't run its env. */
export function buildSshSpawn(
  remote: RemoteRef,
  ctx: SpawnContext,
): { file: string; args: string[] } | null {
  const env = parseSshEnv(remote.env)
  if (!env) return null
  const extra = remote.extraArgs ?? []
  // `--` ends ssh's options, so a destination starting with `-` can never become one.
  const dest = ["-t", "--", remote.target]
  if (env.kind === "native") {
    // Windows' ssh.exe has no ControlMaster support. Our flags go after the user's args:
    // ssh keeps the first value of an option, so a host's own -o ControlMaster=no wins.
    const canReuse = ctx.reuse && ctx.platform !== "win32" && ctx.controlDir !== null
    const reuse = canReuse ? reuseFlags(ctx.controlDir!) : []
    return { file: ctx.sshPath, args: [...extra, ...reuse, ...dest] }
  }
  if (ctx.platform !== "win32") return null
  // `-e` execs directly (no default-shell re-parse of our args); `--cd ~` starts at home.
  const base = ["-d", env.distro, "--cd", "~", "-e"]
  return ctx.reuse
    ? {
        file: "wsl.exe",
        args: [...base, "sh", "-c", WSL_SSH_SCRIPT, "smterm-ssh", remote.target, ...extra],
      }
    : { file: "wsl.exe", args: [...base, "ssh", ...extra, ...dest] }
}

const MAX_LABEL = 200

/** The RemoteRef main will spawn for one the renderer sent. A listed hostId → main's own
 *  copy (target, args, env). Unlisted (host since removed) → the ref's own target and env,
 *  re-validated, with no extra args. null if unusable. */
export function trustedRemote(ref: unknown, hosts: readonly SshHost[]): RemoteRef | null {
  if (!ref || typeof ref !== "object") return null
  const r = ref as Record<string, unknown>
  if (typeof r.hostId !== "string" || !r.hostId) return null
  const known = hosts.find((h) => h.hostId === r.hostId)
  if (known) {
    return {
      hostId: known.hostId,
      label: known.label,
      target: known.target,
      env: known.env,
      ...(known.extraArgs?.length ? { extraArgs: [...known.extraArgs] } : {}),
    }
  }
  if (!isSshTarget(r.target) || !parseSshEnv(r.env)) return null
  const label =
    typeof r.label === "string" && r.label.trim() ? r.label.slice(0, MAX_LABEL) : r.target
  return { hostId: r.hostId, label, target: r.target, env: r.env as SshEnv }
}
