import { describe, expect, it } from "vitest"
import {
  allowedHosts,
  hostAllowed,
  fromOwnPage,
  sameOrigin,
  tokenCookie,
  upgradeAllowed,
} from "./guards"

const hosts = allowedHosts(["mac.tail1.ts.net", "mac"], ["100.1.2.3", "fd7a::1"], 7420)

describe("hostAllowed", () => {
  it("answers only to its own names (DNS rebinding)", () => {
    expect(hostAllowed({ host: "mac:7420" }, hosts)).toBe(true)
    expect(hostAllowed({ host: "MAC.tail1.ts.net:7420" }, hosts)).toBe(true)
    expect(hostAllowed({ host: "100.1.2.3:7420" }, hosts)).toBe(true)
    expect(hostAllowed({ host: "[fd7a::1]:7420" }, hosts)).toBe(true)
    expect(hostAllowed({ host: "evil.example:7420" }, hosts)).toBe(false)
    expect(hostAllowed({}, hosts)).toBe(false)
  })
})

describe("origin checks", () => {
  it("same-origin requests only", () => {
    expect(sameOrigin({ host: "mac:7420" })).toBe(true)
    expect(
      sameOrigin({ host: "mac:7420", origin: "http://mac:7420", "sec-fetch-site": "same-origin" }),
    ).toBe(true)
    expect(sameOrigin({ host: "mac:7420", origin: "https://evil.example" })).toBe(false)
    expect(sameOrigin({ host: "mac:7420", "sec-fetch-site": "cross-site" })).toBe(false)
  })

  it("a WebSocket needs this page's Origin", () => {
    expect(upgradeAllowed({ host: "mac:7420", origin: "http://mac:7420" })).toBe(true)
    expect(upgradeAllowed({ host: "mac:7420" })).toBe(false)
    expect(upgradeAllowed({ host: "mac:7420", origin: "http://evil:7420" })).toBe(false)
  })
})

describe("fromOwnPage", () => {
  it("a POST carrying our own Origin, not another site's form or an image", () => {
    expect(fromOwnPage({ host: "mac:7420", origin: "http://mac:7420" })).toBe(true)
    expect(fromOwnPage({ host: "mac:7420", origin: "http://evil.example" })).toBe(false)
    expect(fromOwnPage({ host: "mac:7420" })).toBe(false)
  })
})

describe("tokenCookie", () => {
  it("reads one cookie", () => {
    expect(tokenCookie({ cookie: "a=1; minmux_remote=abc=; b=2" }, "minmux_remote")).toBe("abc=")
    expect(tokenCookie({ cookie: "a=1" }, "minmux_remote")).toBeNull()
    expect(tokenCookie({}, "minmux_remote")).toBeNull()
  })
})
