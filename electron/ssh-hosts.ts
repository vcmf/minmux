// SSH remotes: the saved-host list and the exact argv a remote session spawns with
// (SSH_REMOTES.md §3–§5). Pure — main supplies the platform, the ssh binary and the
// ControlMaster dir; the renderer only ever sends a RemoteRef.

import path from "node:path"
import type { RemoteRef, SshEnv, SshHost } from "../src/types"
import { hasControlChar, type SshSettings } from "../src/settings/schema"
import type { PlatformPath, SshConfigHost } from "./ssh-config"

/** A parsed SshEnv; null for a malformed one. */
export type ParsedSshEnv = { kind: "native" } | { kind: "wsl"; distro: string }

export function parseSshEnv(env: string): ParsedSshEnv | null {
  if (env === "native") return { kind: "native" }
  const m = /^wsl:([A-Za-z0-9._-]+)$/.exec(env)
  return m ? { kind: "wsl", distro: m[1]! } : null
}

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

/** Config hosts (native, then per WSL distro) + settings hosts → the host list.
 *  `hidden` filters by alias/name; ids are stable and unique (first wins). */
export function mergeHosts({ native, wsl, settings }: MergeInput): SshHost[] {
  const hidden = new Set(settings.hidden)
  const out: SshHost[] = []
  const ids = new Set<string>()
  const add = (h: SshHost) => {
    if (ids.has(h.hostId)) return
    ids.add(h.hostId)
    out.push(h)
  }
  const fromConfig = (h: SshConfigHost, env: SshEnv, idPrefix: string): SshHost => ({
    hostId: `${idPrefix}:${h.alias}`,
    label: h.alias,
    target: h.alias,
    env,
    source: "config",
    ...(hostDetail(h) ? { detail: hostDetail(h) } : {}),
  })
  if (settings.fromSshConfig) {
    for (const h of native) if (!hidden.has(h.alias)) add(fromConfig(h, "native", "native"))
    for (const [distro, hosts] of wsl) {
      for (const h of hosts) {
        if (!hidden.has(h.alias)) add(fromConfig(h, `wsl:${distro}`, `wsl:${distro}`))
      }
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

/** The dir for ControlMaster sockets: ~/.config/smterm/cm, or /tmp/smterm-<uid> when the
 *  home path would push the socket over the limit (the caller must check ownership). */
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

/** A control dir is safe when it's a real dir we own that nobody else can enter: anyone
 *  who can create sockets in it could hijack our connections. */
export function isSafeControlDir(st: DirFacts, uid: number): boolean {
  return st.isDirectory && !st.isSymbolicLink && st.uid === uid && (st.mode & 0o077) === 0
}

/** ControlMaster flags for sockets in `dir`; [] when the path can't be expressed safely
 *  (a `"` or control char would break ssh's option parsing). `%` is escaped as `%%`
 *  because ssh expands % tokens in ControlPath. */
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

// Runs INSIDE a WSL distro (`sh -c`, argv = the ssh args): picks the control dir there
// (short home → ~/.config/smterm/cm, else /tmp/smterm-<uid>), creates it 0700, and adds
// the ControlMaster flags only if it's a real dir we own; any doubt → plain ssh. One line
// (`;`-joined) so it crosses wsl.exe's command line intact.
export const WSL_SSH_SCRIPT = [
  'd="$HOME/.config/smterm/cm"',
  `[ $((\${#d} + ${CONTROL_NAME_BYTES})) -le ${SOCKET_PATH_MAX} ] || d="/tmp/smterm-$(id -u)"`,
  'case "$d" in *[%\\"]*) exec ssh "$@";; esac',
  'mkdir -p "$d" 2>/dev/null && chmod 700 "$d" 2>/dev/null',
  'if [ -d "$d" ] && [ ! -L "$d" ] && [ -O "$d" ]; then' +
    ` exec ssh -o ControlMaster=auto -o "ControlPath=\\"$d/%C\\"" -o ControlPersist=${CONTROL_PERSIST} "$@"; fi`,
  'exec ssh "$@"',
].join("; ")

export interface SpawnContext {
  platform: NodeJS.Platform
  sshPath: string // native ssh binary (`ssh`, or the resolved ssh.exe on Windows)
  controlDir: string | null // a verified-safe native control dir; null = no native reuse
  reuse: boolean // settings.ssh.reuseConnections
}

/** node-pty `file` + `args` for a remote session; null when this platform can't run it
 *  (a WSL host restored on a non-Windows machine, or a malformed env). */
export function buildSshSpawn(
  remote: RemoteRef,
  ctx: SpawnContext,
): { file: string; args: string[] } | null {
  const env = parseSshEnv(remote.env)
  if (!env) return null
  // `--` ends ssh's options, so a destination starting with `-` can never become one.
  const tail = [...(remote.extraArgs ?? []), "-t", "--", remote.target]
  if (env.kind === "native") {
    // Windows' ssh.exe has no ControlMaster support.
    const canReuse = ctx.reuse && ctx.platform !== "win32" && ctx.controlDir !== null
    const reuse = canReuse ? reuseFlags(ctx.controlDir!) : []
    return { file: ctx.sshPath, args: [...reuse, ...tail] }
  }
  if (ctx.platform !== "win32") return null
  // `-e` execs directly (no default-shell re-parse of our args); `--cd ~` starts at home.
  const base = ["-d", env.distro, "--cd", "~", "-e"]
  return ctx.reuse
    ? { file: "wsl.exe", args: [...base, "sh", "-c", WSL_SSH_SCRIPT, "smterm-ssh", ...tail] }
    : { file: "wsl.exe", args: [...base, "ssh", ...tail] }
}
