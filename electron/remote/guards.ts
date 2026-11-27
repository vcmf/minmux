// Request checks for the remote-host server: DNS rebinding (Host), cross-site requests (Origin,
// Sec-Fetch-Site when sent) and who may start an approval (a POST from our own page). Pure.

type Headers = Record<string, string | string[] | undefined>

const one = (h: Headers, k: string): string => {
  const v = h[k]
  return (Array.isArray(v) ? v[0] : v) ?? ""
}

/** The names this server answers to: its MagicDNS name, short name and Tailscale addresses. */
export function allowedHosts(names: string[], ips: string[], port: number): Set<string> {
  const out = new Set<string>()
  for (const n of names.filter(Boolean)) {
    const l = n.toLowerCase()
    out.add(l)
    out.add(`${l}:${port}`)
  }
  for (const ip of ips) {
    const h = ip.includes(":") ? `[${ip}]` : ip
    out.add(h)
    out.add(`${h}:${port}`)
  }
  return out
}

/** The Host header names this server (DNS rebinding check). */
export const hostAllowed = (h: Headers, hosts: Set<string>): boolean =>
  hosts.has(one(h, "host").toLowerCase())

/** A same-origin request: Origin (when sent) is this host; Sec-Fetch-Site (when sent) agrees. */
export function sameOrigin(h: Headers): boolean {
  const origin = one(h, "origin")
  const host = one(h, "host").toLowerCase()
  if (origin && origin.toLowerCase() !== `http://${host}`) return false
  const site = one(h, "sec-fetch-site")
  if (site && site !== "same-origin" && site !== "none") return false
  return true
}

/** A WebSocket upgrade must carry this page's own Origin (browsers always send it). */
export function upgradeAllowed(h: Headers): boolean {
  const origin = one(h, "origin")
  return !!origin && origin.toLowerCase() === `http://${one(h, "host").toLowerCase()}`
}

// Browsers always send Origin on a POST and no site can forge it. (Fetch Metadata would say more,
// but browsers send it to HTTPS pages only; this page is plain HTTP over the tailnet.)
/** A state-changing request from our own page. */
export function fromOwnPage(h: Headers): boolean {
  return upgradeAllowed(h)
}

/** The token cookie's value, if any. */
export function tokenCookie(h: Headers, name: string): string | null {
  for (const part of one(h, "cookie").split(";")) {
    const [k, ...v] = part.trim().split("=")
    if (k === name) return v.join("=") || null
  }
  return null
}
