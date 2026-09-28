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
      h.detail === o.detail &&
      h.hidden === o.hidden
    )
  })
}

/** Where a remote pane runs, for its chip and sidebar subline: the host's `user@hostname:port`
 *  from the list (else its alias), plus the distro for a WSL host. */
export function remoteWhere(r: RemoteRef, hosts: SshHost[]): string {
  const detail = hosts.find((h) => h.hostId === r.hostId)?.detail ?? r.target
  return r.env === "native" ? detail : `${detail} · ${envTitle(r.env)}`
}

/** `*` any run, `?` one character, case-insensitive, like ssh's Host patterns. Linear
 *  (one backtrack point), so no pattern can stall a render the way a regex could. */
export function globMatch(pattern: string, text: string): boolean {
  const p = pattern.toLowerCase()
  const t = text.toLowerCase()
  let pi = 0
  let ti = 0
  let star = -1
  let mark = 0
  while (ti < t.length) {
    if (pi < p.length && (p[pi] === "?" || p[pi] === t[ti])) {
      pi++
      ti++
    } else if (pi < p.length && p[pi] === "*") {
      star = pi++
      mark = ti
    } else if (star !== -1) {
      pi = star + 1
      ti = ++mark
    } else return false
  }
  while (pi < p.length && p[pi] === "*") pi++
  return pi === p.length
}

/** An ssh-style pattern list ("prod-*,db-*,!db-test"): some positive entry matches and no
 *  negated one does. */
export function patternListMatch(list: string, alias: string): boolean {
  let hit = false
  for (const raw of list.split(",")) {
    const entry = raw.trim()
    if (!entry) continue
    if (entry.startsWith("!")) {
      if (globMatch(entry.slice(1), alias)) return false
    } else if (globMatch(entry, alias)) hit = true
  }
  return hit
}

/** The colour the user gave this host (first matching pattern in `ssh.colors`), if any. */
export function hostColor(alias: string, colors: Record<string, string>): string | undefined {
  for (const [pattern, color] of Object.entries(colors)) {
    if (patternListMatch(pattern, alias)) return color
  }
  return undefined
}

/** CSS for a host colour: a theme token for the named ones, the hex as-is. (No named green:
 *  the theme green is the focus / connected colour.) */
export function hostColorCss(color: string): string {
  return color.startsWith("#") ? color : `var(--${color})`
}

/** A host's palette subline (the row's label is the host): its distro for WSL, then
 *  `user@hostname:port`; "" when neither. */
export function hostSubline(h: SshHost): string {
  return [h.env === "native" ? undefined : envTitle(h.env), h.detail].filter(Boolean).join(" · ")
}
