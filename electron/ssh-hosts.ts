// SSH remotes: the saved-host list and the exact argv a remote session spawns with
// (SSH_REMOTES.md §3–§5). Pure — main supplies the platform, the ssh binary and the -F
// wrapper. Connection reuse is left to ssh's own precedence (muxConfigText), so we never
// have to predict the user's multiplexing settings. A RemoteRef from the renderer is
// untrusted: trustedRemote() rebuilds it from main's own host list before spawning.

import path from "node:path"
import type { RemoteRef, SshEnv, SshHost } from "../src/types"
import type { SshSettings } from "../src/settings/schema"
import {
  hasControlChar,
  isSshTarget,
  parseSshEnv,
  sshArgsSetMux,
  validateSshHosts,
} from "../src/lib/ssh-validate"
import type { PlatformPath, SshConfigHost } from "./ssh-config"

/** The sidebar subline for a config host: `user@hostname:port` (parts that are set). */
export function hostDetail(h: SshConfigHost): string | undefined {
  const host = h.hostName ?? (h.user || (h.port && h.port !== "22") ? h.alias : undefined)
  if (!host) return undefined
  const port = h.port && h.port !== "22" ? `:${h.port}` : ""
  return `${h.user ? `${h.user}@` : ""}${host}${port}`
}

export interface MergeInput {
  native: SshConfigHost[] // ~/.ssh/config (+ Includes) on this machine
  wsl: [distro: string, hosts: SshConfigHost[]][] // each distro's config, in distro order
  settings: SshSettings
  platform: NodeJS.Platform // WSL hosts only run on Windows
}

/** Config + settings hosts, ids unique; `all` keeps hidden ones (main's trust list). */
export function mergeHosts(
  { native, wsl, settings, platform }: MergeInput,
  { all = false }: { all?: boolean } = {},
): SshHost[] {
  // ssh matches aliases case-insensitively, so hiding does too.
  const hidden = new Set(all ? [] : settings.hidden.map((h) => h.toLowerCase()))
  const isHidden = (name: string) => hidden.has(name.toLowerCase())
  const runnable = (env: SshEnv) => env === "native" || platform === "win32"
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
  if (settings.fromSshConfig || all) {
    // A config alias is only listed if it's safe as an ssh argv destination.
    const listable = (h: SshConfigHost) => !isHidden(h.alias) && isSshTarget(h.alias)
    for (const h of native) if (listable(h)) add(fromConfig(h, "native", "native"))
    for (const [distro, hosts] of wsl) {
      if (!parseSshEnv(`wsl:${distro}`) || !runnable(`wsl:${distro}`)) continue
      for (const h of hosts) if (listable(h)) add(fromConfig(h, `wsl:${distro}`, `wsl:${distro}`))
    }
  }
  for (const s of validateSshHosts(settings.hosts).hosts) {
    if (isHidden(s.name) || !runnable(s.env)) continue
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

/** Can `dir` sit inside ssh's quoted ControlPath unchanged? (`\\` escapes, `${…}` expands.) */
export const isQuotableDir = (dir: string) => !/["\\$]/.test(dir) && !hasControlChar(dir)

/** The `-F` config smterm runs ssh with: the user's config first, then the system's (ssh's
 *  own order), then our multiplexing defaults — ssh keeps the first value it reads, so any
 *  ControlMaster/ControlPath the user set anywhere wins. null if `dir` can't be quoted. */
export function muxConfigText(
  dir: string,
  includes: { user: string; system: string } = {
    user: "~/.ssh/config",
    system: "/etc/ssh/ssh_config",
  },
): string | null {
  if (!isQuotableDir(dir)) return null
  return [
    "# Written by smterm for connection reuse. Your own config is read first, so anything",
    "# you set there wins; the Host * defaults below only fill in what it leaves unset.",
    `Include ${includes.user}`,
    `Include ${includes.system}`,
    "Host *",
    "  ControlMaster auto",
    `  ControlPath "${dir.replace(/%/g, "%%")}/%C"`,
    `  ControlPersist ${CONTROL_PERSIST}`,
    "",
  ].join("\n")
}

/** stat-like facts about the user's ~/.ssh/config. */
export interface FileFacts {
  isFile: boolean
  uid: number
  mode: number
}

/** ssh refuses a user config others can write — but not through `-F`, so we check first. */
export function isSafeUserConfig(st: FileFacts | null, uid: number): boolean {
  if (st === null) return true // no config: nothing to check
  return st.isFile && (st.uid === uid || st.uid === 0) && (st.mode & 0o022) === 0
}

// Runs INSIDE a WSL distro as `sh -c SCRIPT smterm-ssh <target> <extra args…>`. Mirrors the
// native path there: picks the control dir (short home → ~/.config/smterm/cm, else
// /tmp/smterm-<uid>), creates it 0700 (never through a symlink), refuses a user config
// others can write, writes the same -F wrapper (muxConfigText) and runs ssh with it. Any
// doubt → plain ssh. One line (`;`-joined) so it crosses wsl.exe's command line intact.
export const WSL_SSH_SCRIPT = [
  't="$1"; shift',
  'd="$HOME/.config/smterm/cm"',
  // wc -c counts bytes (as sun_path does); ${#d} would count characters.
  `n=$(printf %s "$d" | wc -c); [ $((n + ${CONTROL_NAME_BYTES})) -le ${SOCKET_PATH_MAX} ] || d="/tmp/smterm-$(id -u)"`,
  // Characters ssh would re-interpret inside the quoted ControlPath (see isQuotableDir).
  "case \"$d\" in *'%'*|*'\"'*|*'$'*|*'\\'*) exec ssh \"$@\" -t -- \"$t\";; esac",
  'c="$HOME/.ssh/config"',
  'if [ -e "$c" ] && { [ ! -O "$c" ] || [ -n "$(find "$c" -prune \\( -perm -020 -o -perm -002 \\) 2>/dev/null)" ]; }; then exec ssh "$@" -t -- "$t"; fi',
  '[ -L "$d" ] || mkdir -p "$d" 2>/dev/null',
  'if [ -d "$d" ] && [ ! -L "$d" ] && [ -O "$d" ] && chmod 700 "$d" 2>/dev/null &&' +
    " printf '%s\\n' '# Written by smterm for connection reuse (see the native file).'" +
    " 'Include ~/.ssh/config' 'Include /etc/ssh/ssh_config' 'Host *' '  ControlMaster auto'" +
    ` "  ControlPath \\"$d/%C\\"" '  ControlPersist ${CONTROL_PERSIST}' > "$d/ssh_config" 2>/dev/null; then` +
    ' exec ssh -F "$d/ssh_config" "$@" -t -- "$t"; fi',
  'exec ssh "$@" -t -- "$t"',
].join("; ")

export interface SpawnContext {
  platform: NodeJS.Platform
  sshPath: string // native ssh binary (`ssh`, or the resolved ssh.exe on Windows)
  muxConfig: string | null // path of a written, verified -F wrapper; null = no native reuse
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
  // Args that set multiplexing or their own config file keep full control: no wrapper
  // (even its lone ControlPath would let `-o ControlMaster=no` join a shared connection).
  const reuse = ctx.reuse && !sshArgsSetMux(extra)
  // `--` ends ssh's options, so a destination starting with `-` can never become one.
  const dest = ["-t", "--", remote.target]
  if (env.kind === "native") {
    // Windows' ssh.exe has no ControlMaster support.
    const useConfig = reuse && ctx.platform !== "win32" && ctx.muxConfig !== null
    const config = useConfig ? ["-F", ctx.muxConfig!] : []
    return { file: ctx.sshPath, args: [...config, ...extra, ...dest] }
  }
  if (ctx.platform !== "win32") return null
  // `-e` execs directly (no default-shell re-parse of our args); `--cd ~` starts at home.
  const base = ["-d", env.distro, "--cd", "~", "-e"]
  return reuse
    ? {
        file: "wsl.exe",
        args: [...base, "sh", "-c", WSL_SSH_SCRIPT, "smterm-ssh", remote.target, ...extra],
      }
    : { file: "wsl.exe", args: [...base, "ssh", ...extra, ...dest] }
}

const MAX_LABEL = 200

/** The RemoteRef to spawn: main's own copy of a known host, else a re-validated bare ref. */
export function trustedRemote(ref: unknown, hosts: readonly SshHost[]): RemoteRef | null {
  if (!ref || typeof ref !== "object") return null
  const r = ref as Record<string, unknown>
  if (typeof r.hostId !== "string" || !r.hostId || r.hostId.length > 300) return null
  if (hasControlChar(r.hostId)) return null
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
  // A settings host that's gone can't be rebuilt safely (its args are unknown): don't guess.
  if (r.hostId.startsWith("settings:")) return null
  if (!isSshTarget(r.target) || !parseSshEnv(r.env)) return null
  const label =
    typeof r.label === "string" && r.label.trim() && !hasControlChar(r.label)
      ? r.label.slice(0, MAX_LABEL)
      : r.target
  return { hostId: r.hostId, label, target: r.target, env: r.env as SshEnv }
}
