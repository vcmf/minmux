// SSH remotes: the ~/.ssh/config host list and the exact argv a remote session spawns with
// (docs/design/SSH_REMOTES.md §3–§5). Pure — main supplies the platform and the ssh
// binary. minmux runs plain `ssh -t -- <alias>`: ssh applies the user's config exactly as in any terminal. A
// RemoteRef from the renderer is untrusted: trustedRemote() takes the host from main's own
// list before anything is spawned.

import type { RemoteRef, SshEnv, SshHost } from "../src/types"
import type { SshSettings } from "../src/lib/ssh-validate"
import { isSshTarget, parseSshEnv } from "../src/lib/ssh-validate"
import type { SshConfigHost } from "./ssh-config"

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
  settings: Pick<SshSettings, "hidden">
  platform: NodeJS.Platform // WSL hosts only run on Windows
}

/** Config hosts (native, then per WSL distro), ids unique; `all` keeps hidden ones. */
export function mergeHosts(
  { native, wsl, settings, platform }: MergeInput,
  { all = false, markHidden = false }: { all?: boolean; markHidden?: boolean } = {},
): SshHost[] {
  // ssh matches aliases case-insensitively, so hiding does too.
  const hidden = new Set(all ? [] : settings.hidden.map((h) => h.toLowerCase()))
  const isHidden = (h: SshConfigHost) => hidden.has(h.alias.toLowerCase())
  // A config alias is only listed if it's safe as an ssh argv destination. With markHidden,
  // hidden ones are listed too, flagged (the renderer can offer to show them again).
  const listable = (h: SshConfigHost) => (markHidden || !isHidden(h)) && isSshTarget(h.alias)
  const out: SshHost[] = []
  const ids = new Set<string>()
  const add = (h: SshConfigHost, env: SshEnv, idPrefix: string) => {
    const hostId = `${idPrefix}:${h.alias}`
    if (ids.has(hostId) || !listable(h)) return
    ids.add(hostId)
    const detail = hostDetail(h)
    out.push({
      hostId,
      label: h.alias,
      target: h.alias,
      env,
      ...(detail ? { detail } : {}),
      ...(markHidden && isHidden(h) ? { hidden: true as const } : {}),
    })
  }
  for (const h of native) add(h, "native", "native")
  if (platform === "win32") {
    for (const [distro, hosts] of wsl) {
      if (!parseSshEnv(`wsl:${distro}`)) continue
      for (const h of hosts) add(h, `wsl:${distro}`, `wsl:${distro}`)
    }
  }
  return out
}

/** ssh's own keepalive (in the encrypted channel): keeps idle NAT/firewall state open and
 *  ends a dead connection after `seconds × 4` instead of hanging. [] for 0. */
export function keepAliveFlags(seconds: number): string[] {
  return seconds > 0 ? ["-o", `ServerAliveInterval=${seconds}`, "-o", "ServerAliveCountMax=4"] : []
}

export interface SpawnContext {
  platform: NodeJS.Platform
  sshPath: string // native ssh binary (resolved full path)
  keepAliveSeconds: number // settings.ssh.keepAliveSeconds
}

/** node-pty file + args for a remote session; null if this platform can't run its env. */
export function buildSshSpawn(
  remote: RemoteRef,
  ctx: SpawnContext,
): { file: string; args: string[] } | null {
  const env = parseSshEnv(remote.env)
  if (!env) return null
  // `--` ends ssh's options, so a destination starting with `-` can never become one.
  const tail = [...keepAliveFlags(ctx.keepAliveSeconds), "-t", "--", remote.target]
  if (env.kind === "native") return { file: ctx.sshPath, args: tail }
  if (ctx.platform !== "win32") return null
  // The distro's own ssh (its keys, config and agent). `-e` execs directly (no default-
  // shell re-parse of our args); `--cd ~` starts at home.
  return { file: "wsl.exe", args: ["-d", env.distro, "--cd", "~", "-e", "ssh", ...tail] }
}

/** The RemoteRef to spawn: main's own copy of a known host, else null (never a guess). */
export function trustedRemote(ref: unknown, hosts: readonly SshHost[]): RemoteRef | null {
  if (!ref || typeof ref !== "object") return null
  // Only an exact match against main's own (validated) list counts. An unknown host (removed
  // from the config, or not loaded) is refused: a bare `ssh <alias>` without its
  // HostName/User could reach a different machine via DNS.
  const hostId = (ref as { hostId?: unknown }).hostId
  const known = typeof hostId === "string" ? hosts.find((h) => h.hostId === hostId) : undefined
  return known
    ? { hostId: known.hostId, label: known.label, target: known.target, env: known.env }
    : null
}
