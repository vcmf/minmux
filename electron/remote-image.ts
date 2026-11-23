// A remote image for a rendered markdown view (docs/design/MARKDOWN.md, step 4). The renderer's
// Content-Security-Policy refuses remote images, so main fetches one and hands it over as a data:
// URL: http(s) only, never a private or loopback host (a document can't make minmux probe the
// local network), no cookies (its own session), an image type, at most IMAGE_MAX, within
// TIMEOUT_MS. Pure apart from the fetch it's given.
import { IMAGE_MAX } from "../src/lib/file-tab"

export type RemoteImage = { ok: true; dataUrl: string } | { ok: false; error: string }
type Fetch = (url: string, init: { signal: AbortSignal; redirect: "manual" }) => Promise<Response>
const HOPS = 5 // redirects followed (each checked before it's asked for)

export const TIMEOUT_MS = 15_000

/** Whether a host is this machine or a private network's (by name or literal address). */
export function privateHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "")
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local")) return true
  if (h === "::1" || h === "::" || /^f[cd][0-9a-f]{2}:/.test(h) || /^fe80:/.test(h)) return true
  const v4 = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(h)
  if (!v4) return false
  const [a, b] = [Number(v4[1]), Number(v4[2])]
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127)
  )
}

/** The image at `url`, as a data: URL; why not, otherwise (never throws). */
export async function fetchImage(
  url: string,
  fetcher: Fetch,
  max = IMAGE_MAX,
): Promise<RemoteImage> {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return { ok: false, error: "Not a URL" }
  }
  if (u.protocol !== "https:" && u.protocol !== "http:")
    return { ok: false, error: "Not a web URL" }
  if (privateHost(u.hostname)) return { ok: false, error: "A local address" }
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), TIMEOUT_MS)
  try {
    // Redirects by hand: a hop to a local address is refused before it's requested.
    let res = await fetcher(u.href, { signal: abort.signal, redirect: "manual" })
    for (let hop = 0; res.status >= 300 && res.status < 400; hop++) {
      const to = res.headers.get("location")
      if (!to || hop >= HOPS) return { ok: false, error: "Too many redirects" }
      u = new URL(to, u)
      if (u.protocol !== "https:" && u.protocol !== "http:") {
        return { ok: false, error: "Not a web URL" }
      }
      if (privateHost(u.hostname)) return { ok: false, error: "A local address" }
      res = await fetcher(u.href, { signal: abort.signal, redirect: "manual" })
    }
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` }
    const type = (res.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase()
    if (!type.startsWith("image/")) return { ok: false, error: "Not an image" }
    if (Number(res.headers.get("content-length") ?? 0) > max)
      return { ok: false, error: "Too large" }
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
    return {
      ok: false,
      error: abort.signal.aborted ? "Timed out" : String((e as Error).message ?? e),
    }
  } finally {
    clearTimeout(timer)
  }
}
