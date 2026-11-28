import { describe, expect, it } from "vitest"
import {
  cliCandidates,
  findCli,
  openUrl,
  parseStatus,
  parseWhois,
  peerAllowed,
  peersOf,
  type SelfNode,
} from "./tailscale"
import { candidates, tokenFrom } from "./peer-client"

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
        label: "has-macbook-pro",
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

  it("opens by MagicDNS name, or by IP without MagicDNS (never by HostName)", () => {
    const a = parseStatus(status())
    expect(a.ok && openUrl(a.self, 7420)).toBe("http://has-macbook-pro:7420")
    const b = parseStatus(status({}, { DNSName: "" }))
    expect(b.ok && b.self.label).toBe("Ha’s MacBook Pro")
    expect(b.ok && openUrl(b.self, 7420)).toBe("http://100.126.45.109:7420")
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

describe("peersOf / candidates: where another minmux may answer", () => {
  const self: SelfNode = {
    userId: "u1",
    nodeId: "n0",
    dnsName: "mac.tail.ts.net",
    shortName: "mac",
    label: "mac",
    ips: ["100.64.0.1"],
    tagged: false,
    certDomains: [],
  }
  const status = JSON.stringify({
    Peer: {
      a: { Online: true, UserID: "u1", DNSName: "linux.tail.ts.net.", OS: "linux" },
      b: { Online: false, UserID: "u1", DNSName: "off.tail.ts.net.", OS: "linux" },
      c: { Online: true, UserID: "u2", DNSName: "theirs.tail.ts.net.", OS: "linux" },
      d: { Online: true, UserID: "u1", DNSName: "srv.tail.ts.net.", Tags: ["tag:ci"] },
      e: { Online: true, UserID: "u1", DNSName: "iphone.tail.ts.net.", OS: "iOS" },
      f: { Online: true, UserID: "u1", DNSName: "", HostName: "box", TailscaleIPs: ["100.64.0.9"] },
      g: { Online: true, UserID: "u1" }, // no address
      h: null,
    },
  })

  it("online, same user, untagged, not a phone; this machine first", () => {
    expect(peersOf(status, self)).toEqual([
      { dnsName: "mac.tail.ts.net", label: "mac", host: "mac.tail.ts.net", self: true },
      { dnsName: "linux.tail.ts.net", label: "linux", host: "linux.tail.ts.net", self: false },
      { dnsName: "", label: "box", host: "100.64.0.9", self: false },
    ])
    expect(peersOf("not json", self)).toEqual([])
    expect(peersOf(status, { ...self, tagged: true })).toEqual([])
  })

  it("each machine on each port, never this minmux's own", () => {
    const peers = peersOf(status, self).slice(0, 2)
    expect(candidates(peers, [7420, 7421], 7420).map((c) => [c.key, c.label])).toEqual([
      ["mac.tail.ts.net:7421", "mac (this computer) · dev"],
      ["linux.tail.ts.net:7420", "linux"],
      ["linux.tail.ts.net:7421", "linux · dev"],
    ])
  })

  it("reads the token from its port's cookie only", () => {
    expect(tokenFrom(["minmux_remote_7420=abc=; HttpOnly"], 7420)).toBe("abc=")
    expect(tokenFrom(["minmux_remote_7421=abc; HttpOnly"], 7420)).toBeNull()
    expect(tokenFrom([], 7420)).toBeNull()
  })
})
