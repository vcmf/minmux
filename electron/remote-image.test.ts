// @vitest-environment node
import { describe, it, expect, vi } from "vitest"
import type dns from "node:dns"
import { fetchImage, guardedLookup, privateHost, privateIp, type Fetch } from "./remote-image"

const png = { "content-type": "image/png" }
const respond = (
  body: ConstructorParameters<typeof Response>[0],
  headers: Record<string, string>,
  status = 200,
) => vi.fn<Fetch>(async () => new Response(body, { status, headers }))
// One answer per URL (a redirect chain).
const chain = (by: Record<string, () => Response>) =>
  vi.fn<Fetch>(async (u) => (by[u] ?? (() => new Response(null, { status: 404 })))())

describe("fetchImage", () => {
  it("returns an image as a data: URL", async () => {
    const f = respond(new Uint8Array([1, 2, 3]), png)
    expect(await fetchImage("https://a.test/x.png", f)).toEqual({
      ok: true,
      dataUrl: "data:image/png;base64,AQID",
    })
  })

  it("refuses what isn't an http(s) image, too big, or failing", async () => {
    expect(await fetchImage("file:///etc/passwd", respond("", png))).toMatchObject({ ok: false })
    expect(await fetchImage("javascript:1", respond("", png))).toMatchObject({ ok: false })
    const html = respond("<html>", { "content-type": "text/html" })
    expect(await fetchImage("https://a.test/", html)).toEqual({ ok: false, error: "Not an image" })
    expect(await fetchImage("https://a.test/", respond("x", png, 404))).toEqual({
      ok: false,
      error: "HTTP 404",
    })
    expect(await fetchImage("https://a.test/", respond(new Uint8Array(10), png), 5)).toEqual({
      ok: false,
      error: "Too large",
    })
    const big = respond("", { ...png, "content-length": "999" })
    expect(await fetchImage("https://a.test/", big, 5)).toEqual({ ok: false, error: "Too large" })
    const boom = vi.fn(async () => Promise.reject(new Error("offline")))
    expect(await fetchImage("https://a.test/", boom)).toEqual({ ok: false, error: "offline" })
    const refused = vi.fn(async () =>
      Promise.reject(Object.assign(new Error("x"), { code: "ELOCAL" })),
    )
    expect(await fetchImage("https://rebind.test/", refused)).toEqual({
      ok: false,
      error: "A local address",
    })
  })

  it("a 3xx without a place to go is its status, not a redirect", async () => {
    expect(await fetchImage("https://a.test/", respond(null, {}, 300))).toEqual({
      ok: false,
      error: "HTTP 300",
    })
  })

  it("never asks a local address as written, nor a redirect hop to one", async () => {
    const f = respond("", png)
    for (const u of [
      "http://localhost:3000/a.png",
      "http://localhost./a.png",
      "http://127.0.0.1/a",
      "http://192.168.1.2/a",
      "http://[::1]/a",
      "http://[::ffff:127.0.0.1]:8080/a.png",
    ]) {
      expect(await fetchImage(u, f), u).toEqual({ ok: false, error: "A local address" })
    }
    expect(f).not.toHaveBeenCalled()
    const hop = chain({
      "https://a.test/x": () =>
        new Response(null, { status: 302, headers: { location: "http://10.0.0.1/x.png" } }),
    })
    expect(await fetchImage("https://a.test/x", hop)).toEqual({
      ok: false,
      error: "A local address",
    })
    expect(hop).toHaveBeenCalledTimes(1)
  })

  it("follows a public redirect, a few hops at most", async () => {
    const hop = chain({
      "https://a.test/x": () =>
        new Response(null, { status: 301, headers: { location: "/y.png" } }),
      "https://a.test/y.png": () => new Response(new Uint8Array([9]), { headers: png }),
    })
    expect(await fetchImage("https://a.test/x", hop)).toEqual({
      ok: true,
      dataUrl: "data:image/png;base64,CQ==",
    })
    const loop = vi.fn(
      async () => new Response(null, { status: 302, headers: { location: "/again" } }),
    )
    expect(await fetchImage("https://a.test/x", loop)).toEqual({
      ok: false,
      error: "Too many redirects",
    })
  })
})

describe("privateIp / privateHost", () => {
  it("knows loopback, private, link-local and mapped addresses, in any notation", () => {
    for (const a of [
      "127.0.0.1",
      "10.1.2.3",
      "172.20.0.1",
      "169.254.1.1",
      "100.64.0.1",
      "0.0.0.0",
      "::1",
      "::",
      "fd00::1",
      "fe90::1",
      "::ffff:127.0.0.1",
      "::ffff:7f00:1",
      "::ffff:c0a8:101",
      "64:ff9b::7f00:1",
      "fe80::1%en0",
    ])
      expect(privateIp(a), a).toBe(true)
    for (const a of ["8.8.8.8", "172.32.0.1", "140.82.112.3", "2606:4700::1111", "::ffff:808:808"])
      expect(privateIp(a), a).toBe(false)
    for (const h of [
      "localhost",
      "localhost.",
      "a.localhost",
      "printer.local",
      "printer.local.",
      "[::1]",
    ])
      expect(privateHost(h), h).toBe(true)
    expect(privateHost("github.com")).toBe(false)
  })
})

describe("guardedLookup", () => {
  const resolver = (addrs: dns.LookupAddress[]) =>
    ((_h: string, _o: unknown, cb: (e: Error | null, a: dns.LookupAddress[]) => void) =>
      cb(null, addrs)) as unknown as typeof dns.lookup

  it("refuses a name with any private address (DNS that points home)", () => {
    const cb = vi.fn()
    guardedLookup(
      resolver([
        { address: "93.184.216.34", family: 4 },
        { address: "127.0.0.1", family: 4 },
      ]),
    )("rebind.test", {}, cb)
    expect(cb.mock.calls[0]![0]).toMatchObject({ code: "ELOCAL" })
  })

  it("answers with the checked address, in the form asked for", () => {
    const ok = resolver([{ address: "93.184.216.34", family: 4 }])
    const one = vi.fn()
    guardedLookup(ok)("a.test", {}, one)
    expect(one).toHaveBeenCalledWith(null, "93.184.216.34", 4)
    const all = vi.fn()
    guardedLookup(ok)("a.test", { all: true }, all)
    expect(all).toHaveBeenCalledWith(null, [{ address: "93.184.216.34", family: 4 }])
  })
})

describe("nodeFetch", () => {
  it("rejects a status a Response can't hold, never throwing in main", async () => {
    const http = await import("node:http")
    const { nodeFetch } = await import("./remote-image")
    const server = http.createServer((req, res) => {
      res.statusCode = req.url === "/205" ? 205 : 999
      res.end("x")
    })
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
    const port = (server.address() as { port: number }).port
    try {
      // (127.0.0.1 itself: fetchImage refuses it before asking; nodeFetch is the raw GET)
      const ok = await nodeFetch(
        `http://127.0.0.1:${port}/205`,
        new AbortController().signal,
      ).catch((e: Error) => e)
      expect(ok).toBeInstanceOf(Response)
      expect((ok as Response).status).toBe(205)
      const bad = await nodeFetch(
        `http://127.0.0.1:${port}/999`,
        new AbortController().signal,
      ).catch((e: Error) => e)
      expect(bad).toBeInstanceOf(Error)
      expect((bad as Error).message).toBe("HTTP 999")
    } finally {
      server.close()
    }
  })
})
