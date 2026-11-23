// A remote image for a rendered markdown view (docs/design/MARKDOWN.md, step 4). The renderer's
// Content-Security-Policy refuses remote images, so main fetches one and hands it over as a data:
// URL. A document must not make minmux reach the local network: the request goes through Node's
// http(s) with a lookup that refuses a name resolving to any private or loopback address and
// connects to the address it checked (no second resolution to rebind); a literal address is
// checked as written; each redirect hop is checked before it's asked for. Node keeps no cookies.
// http(s) only, an image type, at most IMAGE_MAX, within TIMEOUT_MS. (No system proxy: Node's
// client doesn't read it.)
import dns from "node:dns"
import http from "node:http"
import https from "node:https"
import net from "node:net"
import { Readable } from "node:stream"
import { IMAGE_MAX } from "../src/lib/file-tab"

export type RemoteImage = { ok: true; dataUrl: string } | { ok: false; error: string }
export type Fetch = (url: string, signal: AbortSignal) => Promise<Response>

export const TIMEOUT_MS = 15_000
const HOPS = 5 // redirects followed

const LOCAL = new net.BlockList()
for (const [a, n] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["224.0.0.0", 3], // multicast and reserved, to the top
] as const)
  LOCAL.addSubnet(a, n, "ipv4")
for (const [a, n] of [
  ["::", 128],
  ["::1", 128],
  ["64:ff9b::", 96], // NAT64: an IPv4 address inside
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const)
  LOCAL.addSubnet(a, n, "ipv6")

/** Whether an IP address is this machine's or a private network's (IPv4 inside IPv6 too). */
export function privateIp(address: string): boolean {
  // A scoped address (fe80::1%en0) is link-local whatever its zone: the zone is dropped first.
  const a = address
    .replace(/^\[|\]$/g, "")
    .replace(/%.*$/, "")
    .toLowerCase()
  const kind = net.isIP(a)
  if (kind === 4) return LOCAL.check(a, "ipv4")
  if (kind !== 6) return false
  // ::ffff:a.b.c.d (mapped) and ::a.b.c.d (compatible), in either notation: its IPv4 decides.
  const groups = new URL(`http://[${a}]`).hostname.slice(1, -1) // normalized, compressed
  const m = /^::(?:ffff:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(groups)
  if (m) {
    const hi = parseInt(m[1]!, 16)
    const lo = parseInt(m[2]!, 16)
    return LOCAL.check(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`, "ipv4")
  }
  return LOCAL.check(a, "ipv6")
}

/** Whether a URL's host is, as written, local: a local name or a private literal address. */
export function privateHost(host: string): boolean {
  const h = host
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "")
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local")) return true
  return privateIp(h)
}

type Lookup = typeof dns.lookup
type LookupCb = (err: Error | null, address: string | dns.LookupAddress[], family?: number) => void

/** dns.lookup that refuses a name with any private address (the socket connects to one checked). */
export function guardedLookup(resolve: Lookup = dns.lookup) {
  return (host: string, opts: dns.LookupOptions, cb: LookupCb): void => {
    resolve(host, { ...opts, all: true }, (err, addrs) => {
      if (err) return cb(err, "")
      const list = addrs as dns.LookupAddress[]
      let local = !list.length
      try {
        local ||= list.some((a) => privateIp(a.address))
      } catch {
        local = true // an address it can't read: not asked
      }
      if (local) {
        return cb(Object.assign(new Error("A local address"), { code: "ELOCAL" }), "")
      }
      if (opts.all) cb(null, list)
      else cb(null, list[0]!.address, list[0]!.family)
    })
  }
}

/** One GET through Node's http(s), redirects not followed, as a fetch Response. */
export const nodeFetch: Fetch = (url, signal) =>
  new Promise((resolve, reject) => {
    const u = new URL(url)
    const get = u.protocol === "https:" ? https.get : http.get
    const req = get(u, { signal, lookup: guardedLookup() as never, headers: { accept: "image/*" } })
    req.on("error", reject)
    // Never throws out of this listener (that would be an uncaught error in main): a status a
    // Response can't hold, or a header it refuses, rejects instead.
    req.on("response", (res) => {
      try {
        const status = res.statusCode ?? 0
        if (status < 200 || status > 599) throw new Error(`HTTP ${status}`)
        const headers = new Headers()
        for (const [k, v] of Object.entries(res.headers)) {
          if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(", ") : v)
        }
        const empty = status === 204 || status === 205 || status === 304
        if (empty) res.resume()
        resolve(
          new Response(empty ? null : (Readable.toWeb(res) as ReadableStream), { status, headers }),
        )
      } catch (e) {
        res.destroy()
        reject(e instanceof Error ? e : new Error(String(e)))
      }
    })
  })

/** The image at `url`, as a data: URL; why not, otherwise (never throws). */
export async function fetchImage(
  url: string,
  fetcher: Fetch = nodeFetch,
  max = IMAGE_MAX,
): Promise<RemoteImage> {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return { ok: false, error: "Not a URL" }
  }
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), TIMEOUT_MS)
  let res: Response | undefined
  try {
    for (let hop = 0; ; hop++) {
      if (u.protocol !== "https:" && u.protocol !== "http:") {
        return { ok: false, error: "Not a web URL" }
      }
      if (privateHost(u.hostname)) return { ok: false, error: "A local address" }
      res = await fetcher(u.href, abort.signal)
      const to = res.headers.get("location")
      if (res.status < 300 || res.status >= 400 || !to) break
      void res.body?.cancel()
      if (hop >= HOPS) return { ok: false, error: "Too many redirects" }
      u = new URL(to, u)
    }
    if (!res.ok) {
      void res.body?.cancel()
      return { ok: false, error: `HTTP ${res.status}` }
    }
    const type = (res.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase()
    if (!type.startsWith("image/")) {
      void res.body?.cancel()
      return { ok: false, error: "Not an image" }
    }
    if (Number(res.headers.get("content-length") ?? 0) > max) {
      void res.body?.cancel()
      return { ok: false, error: "Too large" }
    }
    const reader = res.body?.getReader()
    if (!reader) return { ok: false, error: "No body" }
    const parts: Uint8Array[] = []
    let size = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > max) {
        void reader.cancel()
        return { ok: false, error: "Too large" }
      }
      parts.push(value)
    }
    return { ok: true, dataUrl: `data:${type};base64,${Buffer.concat(parts).toString("base64")}` }
  } catch (e) {
    if (abort.signal.aborted) return { ok: false, error: "Timed out" }
    const err = e as { code?: string; message?: string }
    if (err.code === "ELOCAL") return { ok: false, error: "A local address" }
    return { ok: false, error: String(err.message ?? e) }
  } finally {
    clearTimeout(timer)
  }
}
