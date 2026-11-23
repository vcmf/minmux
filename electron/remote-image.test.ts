// @vitest-environment node
import { describe, it, expect, vi } from "vitest"
import { fetchImage, privateHost } from "./remote-image"

const respond = (
  body: Uint8Array | string,
  headers: Record<string, string>,
  status = 200,
  url = "",
) =>
  vi.fn(async () => {
    const r = new Response(body, { status, headers })
    if (url) Object.defineProperty(r, "url", { value: url })
    return r
  })

describe("fetchImage", () => {
  it("returns an image as a data: URL", async () => {
    const f = respond(new Uint8Array([1, 2, 3]), { "content-type": "image/png" })
    expect(await fetchImage("https://a.test/x.png", f)).toEqual({
      ok: true,
      dataUrl: "data:image/png;base64,AQID",
    })
    expect(f).toHaveBeenCalledWith(
      "https://a.test/x.png",
      expect.objectContaining({ redirect: "manual" }),
    )
  })

  it("refuses what isn't an http(s) image, too big, or failing", async () => {
    const png = { "content-type": "image/png" }
    expect(await fetchImage("file:///etc/passwd", respond("", png))).toMatchObject({ ok: false })
    expect(await fetchImage("javascript:1", respond("", png))).toMatchObject({ ok: false })
    expect(
      await fetchImage("https://a.test/", respond("<html>", { "content-type": "text/html" })),
    ).toEqual({
      ok: false,
      error: "Not an image",
    })
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
  })

  it("never fetches a local address, nor follows a redirect to one", async () => {
    const f = respond("", { "content-type": "image/png" })
    for (const u of [
      "http://localhost:3000/a.png",
      "http://127.0.0.1/a",
      "http://192.168.1.2/a",
      "http://[::1]/a",
    ]) {
      expect(await fetchImage(u, f)).toEqual({ ok: false, error: "A local address" })
    }
    expect(f).not.toHaveBeenCalled()
    const hop = vi.fn(async (u: string) =>
      u === "https://a.test/x"
        ? new Response(null, { status: 302, headers: { location: "http://10.0.0.1/x.png" } })
        : new Response("x", { headers: { "content-type": "image/png" } }),
    )
    expect(await fetchImage("https://a.test/x", hop)).toEqual({
      ok: false,
      error: "A local address",
    })
    expect(hop).toHaveBeenCalledTimes(1) // the local one is never asked
  })

  it("follows a public redirect, a few hops at most", async () => {
    const hop = vi.fn(async (u: string) =>
      u === "https://a.test/x"
        ? new Response(null, { status: 301, headers: { location: "/y.png" } })
        : new Response(new Uint8Array([9]), { headers: { "content-type": "image/png" } }),
    )
    expect(await fetchImage("https://a.test/x", hop)).toEqual({
      ok: true,
      dataUrl: "data:image/png;base64,CQ==",
    })
    expect(hop).toHaveBeenLastCalledWith("https://a.test/y.png", expect.anything())
    const loop = vi.fn(
      async () => new Response(null, { status: 302, headers: { location: "/again" } }),
    )
    expect(await fetchImage("https://a.test/x", loop)).toEqual({
      ok: false,
      error: "Too many redirects",
    })
  })
})

describe("privateHost", () => {
  it("knows loopback, private and link-local ranges", () => {
    for (const h of [
      "localhost",
      "a.localhost",
      "printer.local",
      "10.1.2.3",
      "172.20.0.1",
      "169.254.1.1",
      "::1",
      "fd00::1",
      "100.64.0.1",
    ])
      expect(privateHost(h), h).toBe(true)
    for (const h of ["github.com", "8.8.8.8", "172.32.0.1", "user-images.githubusercontent.com"])
      expect(privateHost(h), h).toBe(false)
  })
})
