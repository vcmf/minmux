import type { RemoteRef, Session, ShellOption, SshEnv, SshHost } from "../types"

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

/** hostIds with a live ssh (not dialing, not waiting at a Connect prompt, not a restored
 *  pane that hasn't started), sorted — a stable primitive list for useShallow. */
export function connectedHostIds(
  sessions: Record<string, Session>,
  phases: Record<string, string>,
): string[] {
  const ids = new Set<string>()
  for (const s of Object.values(sessions)) {
    const p = phases[s.id]
    if (s.remote && (p === "live" || p === "prompt")) ids.add(s.remote.hostId) // ssh is running
  }
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

/** A remote session's subline: "ssh · web", plus the distro for a WSL host. */
export function remoteSubline(r: RemoteRef): string {
  return r.env === "native" ? `ssh · ${r.target}` : `ssh · ${r.target} · ${envTitle(r.env)}`
}

/** A remote pane's badge: "ssh", plus the distro for a WSL host (the title is the host). */
export function remoteBadge(r: RemoteRef): string {
  return r.env === "native" ? "ssh" : `ssh · ${envTitle(r.env)}`
}

/** A host's palette subline: "web · me@10.0.0.1", with the distro for a WSL host. */
export function hostSubline(h: SshHost): string {
  return [h.label, h.env === "native" ? undefined : envTitle(h.env), h.detail]
    .filter(Boolean)
    .join(" · ")
}
