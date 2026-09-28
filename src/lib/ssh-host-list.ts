// Which saved ssh hosts show where, and in what order (pure; the picker, sidebar, palette and
// new-tab menu all read from here).

import type { SshHost } from "../types"
import { envTitle } from "./ssh-hosts-ui"

/** Hosts you can open: everything main listed except the ones in `ssh.hidden`. */
export const visibleHosts = (hosts: SshHost[]): SshHost[] => hosts.filter((h) => !h.hidden)

/** The ones in `ssh.hidden` (the picker's "Hidden (N)" footer lists them to show again). */
export const hiddenHosts = (hosts: SshHost[]): SshHost[] => hosts.filter((h) => h.hidden)

export interface HostSection {
  title: "Pinned" | "Recent" | "All hosts"
  hosts: SshHost[]
}

/** The picker's list: pinned (in pin order), then recent (newest first), then the rest in
 *  config order. Each host once; hidden ones never. */
export function hostSections(
  hosts: SshHost[],
  o: { pinned: string[]; recent: string[] },
): HostSection[] {
  const byId = new Map(visibleHosts(hosts).map((h) => [h.hostId, h]))
  const used = new Set<string>()
  const take = (ids: string[]) =>
    ids.flatMap((id) => {
      const h = byId.get(id)
      if (!h || used.has(id)) return []
      used.add(id)
      return [h]
    })
  const pinned = take(o.pinned)
  const recent = take(o.recent)
  const rest = [...byId.values()].filter((h) => !used.has(h.hostId))
  const out: HostSection[] = []
  if (pinned.length) out.push({ title: "Pinned", hosts: pinned })
  if (recent.length) out.push({ title: "Recent", hosts: recent })
  if (rest.length) out.push({ title: "All hosts", hosts: rest })
  return out
}

/** Hosts matching every word of `query` in their alias, detail or environment; alias-prefix
 *  matches first, then alias-contains, then the rest (stable within each). */
export function filterHosts(hosts: SshHost[], query: string): SshHost[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (!words.length) return hosts
  const hay = (h: SshHost) =>
    `${h.label} ${h.detail ?? ""} ${h.env === "native" ? "" : envTitle(h.env)}`.toLowerCase()
  const hits = hosts.filter((h) => words.every((w) => hay(h).includes(w)))
  const rank = (h: SshHost) => {
    const l = h.label.toLowerCase()
    return l.startsWith(words[0]!) ? 0 : l.includes(words[0]!) ? 1 : 2
  }
  return hits
    .map((h, i) => ({ h, i, r: rank(h) }))
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .map((x) => x.h)
}

/** The sidebar's short list: pinned hosts, then any other host with a pane open. */
export function sidebarHosts(hosts: SshHost[], pinned: string[], open: string[]): SshHost[] {
  const visible = visibleHosts(hosts)
  const byId = new Map(visible.map((h) => [h.hostId, h]))
  const out: SshHost[] = []
  const seen = new Set<string>()
  for (const id of [...pinned, ...open]) {
    const h = byId.get(id)
    if (h && !seen.has(id)) {
      seen.add(id)
      out.push(h)
    }
  }
  return out
}

const MAX_RECENT = 10

/** `recent` with `hostId` moved to the front, capped. */
export function pushRecent(recent: string[], hostId: string): string[] {
  return [hostId, ...recent.filter((id) => id !== hostId)].slice(0, MAX_RECENT)
}

/** `pinned` with `hostId` added (at the end) or removed. */
export function togglePinned(pinned: string[], hostId: string): string[] {
  return pinned.includes(hostId) ? pinned.filter((id) => id !== hostId) : [...pinned, hostId]
}

/** `hidden` with `alias` added or removed (aliases compare case-insensitively, as in ssh). */
export function toggleHidden(hidden: string[], alias: string, hide: boolean): string[] {
  const rest = hidden.filter((a) => a.toLowerCase() !== alias.toLowerCase())
  return hide ? [...rest, alias] : rest
}

/** The shell command that opens this host, for "Copy ssh command". */
export function sshCommand(h: SshHost): string {
  return h.env === "native" ? `ssh ${h.target}` : `wsl -d ${h.env.slice(4)} ssh ${h.target}`
}

export type HostActionId =
  "open" | "splitRight" | "splitDown" | "copyCommand" | "pin" | "hide" | "openConfig"

/** A host row's right-click menu. */
export function hostMenuItems(o: { pinned: boolean; native: boolean }) {
  return [
    { id: "open" as HostActionId, label: "Open in new tab" },
    { id: "splitRight" as HostActionId, label: "Split right" },
    { id: "splitDown" as HostActionId, label: "Split down" },
    { id: "copyCommand" as HostActionId, label: "Copy ssh command", separatorBefore: true },
    { id: "pin" as HostActionId, label: o.pinned ? "Unpin from sidebar" : "Pin to sidebar" },
    { id: "hide" as HostActionId, label: "Hide host" },
    // The ssh config smterm can open is this machine's; a WSL host's lives in its distro.
    ...(o.native
      ? [{ id: "openConfig" as HostActionId, label: "Open ssh config", separatorBefore: true }]
      : []),
  ]
}
