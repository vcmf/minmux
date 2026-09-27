import type { Session, ShellOption, SshEnv, SshHost } from "../types"

/** The ShellOption that opens a terminal on `host` (main builds the real ssh command). */
export function hostShellOption(host: SshHost): ShellOption {
  return {
    id: host.hostId,
    label: host.label,
    command: "ssh",
    args: [],
    remote: { hostId: host.hostId, label: host.label, target: host.target, env: host.env },
  }
}

/** A heading for a host's environment: "This machine" or "WSL: Ubuntu". */
export function envTitle(env: SshEnv): string {
  return env === "native" ? "This machine" : `WSL: ${env.slice("wsl:".length)}`
}

export interface HostGroup {
  env: SshEnv
  title: string
  hosts: SshHost[]
}

/** Hosts grouped by environment, in first-seen order (main lists native before WSL). */
export function groupHosts(hosts: SshHost[]): HostGroup[] {
  const groups = new Map<SshEnv, HostGroup>()
  for (const h of hosts) {
    let g = groups.get(h.env)
    if (!g) groups.set(h.env, (g = { env: h.env, title: envTitle(h.env), hosts: [] }))
    g.hosts.push(h)
  }
  return [...groups.values()]
}

/** hostIds with an open session, sorted (a stable primitive list for useShallow). */
export function connectedHostIds(sessions: Record<string, Session>): string[] {
  const ids = new Set<string>()
  for (const s of Object.values(sessions)) if (s.remote) ids.add(s.remote.hostId)
  return [...ids].sort()
}

/** Same hosts in the same order with the same fields (keeps the store reference stable). */
export function sameHosts(a: SshHost[], b: SshHost[]): boolean {
  if (a.length !== b.length) return false
  return a.every((h, i) => {
    const o = b[i]!
    return (
      h.hostId === o.hostId &&
      h.label === o.label &&
      h.target === o.target &&
      h.env === o.env &&
      h.detail === o.detail
    )
  })
}
