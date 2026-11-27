// Tailscale, as remote control uses it: find the CLI, read this machine's identity
// (`status --json`) and a peer's (`whois --json`). Runs in the remote-host worker, never main.
// The parsers are pure and tolerate missing fields: Tailscale's JSON is not a stable API.

import { execFile } from "node:child_process"
import fs from "node:fs"
import path from "node:path"

/** This machine on the tailnet. */
export interface SelfNode {
  userId: string
  nodeId: string
  dnsName: string // "has-macbook-pro.tail84fc6b.ts.net" (no trailing dot)
  shortName: string // "has-macbook-pro" (MagicDNS); "" without it
  label: string // what to call it on screen: the short name, else Tailscale's host name
  ips: string[] // Tailscale addresses, IPv4 first
  tagged: boolean
  certDomains: string[]
}

/** The node behind a connection. */
export interface PeerNode {
  userId: string
  nodeId: string
  name: string // short device name ("iphone-15")
  tagged: boolean
}

export type SelfResult =
  | { ok: true; self: SelfNode }
  | { ok: false; reason: "missing" | "stopped" | "signed-out" | "error"; detail?: string }

/** Where the CLI may live, in lookup order (PATH entries first). */
export function cliCandidates(
  platform: NodeJS.Platform,
  envPath: string,
  env: NodeJS.ProcessEnv,
): string[] {
  const exe = platform === "win32" ? "tailscale.exe" : "tailscale"
  const sep = platform === "win32" ? ";" : ":"
  const fromPath = envPath
    .split(sep)
    .filter(Boolean)
    .map((d) => path.join(d, exe))
  const fixed =
    platform === "darwin"
      ? [
          "/usr/local/bin/tailscale",
          "/opt/homebrew/bin/tailscale",
          "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
        ]
      : platform === "win32"
        ? [path.join(env.ProgramFiles || "C:\\Program Files", "Tailscale", "tailscale.exe")]
        : ["/usr/bin/tailscale", "/usr/local/bin/tailscale", "/usr/sbin/tailscale"]
  return [...new Set([...fromPath, ...fixed])]
}

/** The first candidate that exists as a file. */
export function findCli(
  candidates: string[],
  isFile = (p: string) => fs.statSync(p).isFile(),
): string | null {
  for (const c of candidates) {
    try {
      if (isFile(c)) return c
    } catch {
      // not there
    }
  }
  return null
}

const str = (v: unknown): string =>
  typeof v === "string" ? v : typeof v === "number" ? String(v) : ""
const strs = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []
const trimDot = (s: string) => s.replace(/\.$/, "")
const firstLabel = (s: string) => trimDot(s).split(".")[0] ?? ""

/** `tailscale status --json` → this machine, or why it can't be used. */
export function parseStatus(raw: string): SelfResult {
  let o: Record<string, unknown>
  try {
    o = JSON.parse(raw) as Record<string, unknown>
  } catch {
    return { ok: false, reason: "error", detail: "unreadable status" }
  }
  const backend = str(o.BackendState)
  if (backend === "NeedsLogin" || backend === "NeedsMachineAuth")
    return { ok: false, reason: "signed-out" }
  if (backend && backend !== "Running") return { ok: false, reason: "stopped", detail: backend }
  const self = (o.Self ?? {}) as Record<string, unknown>
  const ips = strs(self.TailscaleIPs).sort(
    (a, b) => Number(a.includes(":")) - Number(b.includes(":")),
  )
  const dnsName = trimDot(str(self.DNSName))
  const userId = str(self.UserID)
  if (!userId || ips.length === 0) return { ok: false, reason: "stopped" }
  return {
    ok: true,
    self: {
      userId,
      nodeId: str(self.ID),
      dnsName,
      shortName: firstLabel(dnsName),
      label: firstLabel(dnsName) || str(self.HostName) || "this computer",
      ips,
      tagged: strs(self.Tags).length > 0,
      certDomains: strs(o.CertDomains),
    },
  }
}

/** `tailscale whois --json <addr>` → the peer, or null when it's not a tailnet node. */
export function parseWhois(raw: string): PeerNode | null {
  let o: Record<string, unknown>
  try {
    o = JSON.parse(raw) as Record<string, unknown>
  } catch {
    return null
  }
  const node = (o.Node ?? {}) as Record<string, unknown>
  const user = (o.UserProfile ?? {}) as Record<string, unknown>
  const userId = str(user.ID)
  const nodeId = str(node.ID) || str(node.StableID)
  if (!userId || !nodeId) return null
  return {
    userId,
    nodeId,
    // iOS reports HostName "localhost": the DNS name's first label is the real device name.
    name:
      firstLabel(str(node.Name)) ||
      str(node.ComputedName) ||
      str((node.Hostinfo as { Hostname?: unknown })?.Hostname) ||
      "device",
    tagged: strs(node.Tags).length > 0,
  }
}

/** The address to open: the MagicDNS name when there is one, else the Tailscale IPv4. */
export function openUrl(self: SelfNode, port: number): string {
  if (self.shortName) return `http://${self.shortName}:${port}`
  const ip = self.ips.find((a) => !a.includes(":")) ?? `[${self.ips[0]}]`
  return `http://${ip}:${port}`
}

/** Remote control's identity rule: an untagged peer of this machine's own (untagged) user. */
export function peerAllowed(self: SelfNode, peer: PeerNode): boolean {
  return !self.tagged && !peer.tagged && peer.userId === self.userId
}

/** Runs the CLI with a timeout; resolves stdout or rejects. */
export function runCli(cli: string, args: string[], timeoutMs = 5000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      cli,
      args,
      { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
      (err, stdout) => (err ? reject(err) : resolve(stdout)),
    )
  })
}
