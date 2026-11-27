import { describe, expect, it } from "vitest"
import { cliCandidates, findCli, parseStatus, parseWhois, peerAllowed } from "./tailscale"

const status = (over: Record<string, unknown> = {}, self: Record<string, unknown> = {}) =>
  JSON.stringify({
    BackendState: "Running",
    CertDomains: null,
    Self: {
      ID: "n-self",
      UserID: 77,
      DNSName: "has-macbook-pro.tail84fc6b.ts.net.",
      HostName: "Ha’s MacBook Pro",
      TailscaleIPs: ["fd7a:115c:a1e0::1", "100.126.45.109"],
      ...self,
    },
    ...over,
  })

describe("parseStatus", () => {
  it("reads this machine", () => {
    const r = parseStatus(status())
    expect(r).toEqual({
      ok: true,
      self: {
        userId: "77",
        nodeId: "n-self",
        dnsName: "has-macbook-pro.tail84fc6b.ts.net",
        shortName: "has-macbook-pro",
        ips: ["100.126.45.109", "fd7a:115c:a1e0::1"],
        tagged: false,
        certDomains: [],
      },
    })
  })

  it("says why Tailscale can't be used", () => {
    expect(parseStatus(status({ BackendState: "NeedsLogin" }))).toMatchObject({
      ok: false,
      reason: "signed-out",
    })
    expect(parseStatus(status({ BackendState: "Stopped" }))).toMatchObject({
      ok: false,
      reason: "stopped",
    })
    expect(parseStatus("nope")).toMatchObject({ ok: false, reason: "error" })
    expect(parseStatus(status({}, { TailscaleIPs: [] }))).toMatchObject({ ok: false })
  })

  it("flags a tagged machine", () => {
    const r = parseStatus(status({}, { Tags: ["tag:server"] }))
    expect(r.ok && r.self.tagged).toBe(true)
  })
})

describe("parseWhois / peerAllowed", () => {
  const whois = (node: Record<string, unknown>, user: Record<string, unknown> = { ID: 77 }) =>
    JSON.stringify({
      Node: { ID: 5, Name: "iphone-15.tail84fc6b.ts.net.", ...node },
      UserProfile: user,
    })

  it("names an iPhone from its DNS name, not HostName localhost", () => {
    expect(parseWhois(whois({ Hostinfo: { Hostname: "localhost" } }))).toEqual({
      userId: "77",
      nodeId: "5",
      name: "iphone-15",
      tagged: false,
    })
  })

  it("admits only my own untagged devices, from an untagged machine", () => {
    const self = (parseStatus(status()) as { self: import("./tailscale").SelfNode }).self
    const mine = parseWhois(whois({}))!
    expect(peerAllowed(self, mine)).toBe(true)
    expect(peerAllowed(self, parseWhois(whois({}, { ID: 88 }))!)).toBe(false)
    expect(peerAllowed(self, parseWhois(whois({ Tags: ["tag:ci"] }))!)).toBe(false)
    expect(peerAllowed({ ...self, tagged: true }, mine)).toBe(false)
    expect(parseWhois("{}")).toBeNull()
    expect(parseWhois("x")).toBeNull()
  })
})

describe("CLI lookup", () => {
  it("tries PATH first, then the known install places", () => {
    const c = cliCandidates("darwin", "/a:/b", {})
    expect(c.slice(0, 2)).toEqual(["/a/tailscale", "/b/tailscale"])
    expect(c).toContain("/Applications/Tailscale.app/Contents/MacOS/Tailscale")
    expect(findCli(c, (p) => p === "/usr/local/bin/tailscale")).toBe("/usr/local/bin/tailscale")
    expect(findCli(c, () => false)).toBeNull()
    const w = cliCandidates("win32", "", { ProgramFiles: "D:\\PF" })
    expect(w.some((p) => p.includes("Tailscale") && p.endsWith("tailscale.exe"))).toBe(true)
  })
})
