import { describe, expect, it } from "vitest"
import { testHost } from "../test/helpers"
import type { SshHost } from "../types"
import {
  filterHosts,
  hiddenHosts,
  hostMenuItems,
  hostSections,
  pushRecent,
  sidebarHosts,
  sshCommand,
  toggleHidden,
  togglePinned,
  visibleHosts,
} from "./ssh-host-list"

const hidden = (h: SshHost): SshHost => ({ ...h, hidden: true })
const a = testHost("alpha", "native", "me@10.0.0.1")
const b = testHost("beta")
const c = testHost("gpu", "wsl:Ubuntu", "u@gpu")
const g = hidden(testHost("github.com"))
const all = [a, b, c, g]

describe("visibleHosts / hiddenHosts", () => {
  it("split main's list on the hidden flag", () => {
    expect(visibleHosts(all)).toEqual([a, b, c])
    expect(hiddenHosts(all)).toEqual([g])
  })
})

describe("hostSections", () => {
  it("pinned (pin order), recent (newest first), then the rest in config order; each once", () => {
    const s = hostSections(all, { pinned: [c.hostId, a.hostId], recent: [a.hostId, b.hostId] })
    expect(s.map((x) => [x.title, x.hosts.map((h) => h.label)])).toEqual([
      ["Pinned", ["gpu", "alpha"]],
      ["Recent", ["beta"]],
    ])
  })

  it("skips ids that aren't listed (or are hidden), and empty sections", () => {
    const s = hostSections(all, { pinned: ["native:gone", g.hostId], recent: [] })
    expect(s.map((x) => x.title)).toEqual(["All hosts"])
    expect(s[0]!.hosts.map((h) => h.label)).toEqual(["alpha", "beta", "gpu"])
  })
})

describe("filterHosts", () => {
  it("every word must match the alias, detail or environment", () => {
    expect(filterHosts(all, "10.0").map((h) => h.label)).toEqual(["alpha"])
    expect(filterHosts(all, "ubuntu u@").map((h) => h.label)).toEqual(["gpu"])
    expect(filterHosts(all, "nothing")).toEqual([])
    expect(filterHosts(all, "  ")).toEqual(all)
  })

  it("alias-prefix matches first, then alias-contains, then detail-only", () => {
    const hosts = [testHost("x-web"), testHost("db", "native", "web.internal"), testHost("web")]
    expect(filterHosts(hosts, "web").map((h) => h.label)).toEqual(["web", "x-web", "db"])
  })
})

describe("sidebarHosts", () => {
  it("pinned, then any other host with a pane open; hidden or unlisted ones never", () => {
    expect(
      sidebarHosts(all, [b.hostId, g.hostId], [a.hostId, b.hostId, "native:gone"]).map(
        (h) => h.label,
      ),
    ).toEqual(["beta", "alpha"])
    expect(sidebarHosts(all, [], [])).toEqual([])
  })
})

describe("pushRecent / togglePinned / toggleHidden", () => {
  it("recent moves to the front, once, capped at 10", () => {
    expect(pushRecent(["x", "y"], "y")).toEqual(["y", "x"])
    const many = Array.from({ length: 10 }, (_, i) => `h${i}`)
    expect(pushRecent(many, "new")).toHaveLength(10)
    expect(pushRecent(many, "new")[0]).toBe("new")
  })

  it("pins toggle at the end; hidden toggles case-insensitively", () => {
    expect(togglePinned(["a"], "b")).toEqual(["a", "b"])
    expect(togglePinned(["a", "b"], "a")).toEqual(["b"])
    expect(toggleHidden(["GitHub.com", "x"], "github.com", false)).toEqual(["x"])
    expect(toggleHidden(["x"], "web", true)).toEqual(["x", "web"])
    expect(toggleHidden(["WEB"], "web", true)).toEqual(["web"]) // once
  })
})

describe("sshCommand", () => {
  it("what you'd type in any terminal", () => {
    expect(sshCommand(a)).toBe("ssh alpha")
    expect(sshCommand(c)).toBe("wsl -d Ubuntu ssh gpu")
  })
})

describe("hostMenuItems", () => {
  it("offers pin or unpin, and the config only for this machine's hosts", () => {
    const native = hostMenuItems({ pinned: false, native: true, integration: false }).map(
      (i) => i.label,
    )
    expect(native).toContain("Pin to sidebar")
    expect(native).toContain("Open ssh config")
    const wsl = hostMenuItems({ pinned: true, native: false, integration: true }).map(
      (i) => i.label,
    )
    expect(wsl).toContain("Unpin from sidebar")
    expect(wsl).not.toContain("Open ssh config")
    expect(native).toContain("Turn on shell integration")
    expect(wsl).toContain("Turn off shell integration")
    const off = hostMenuItems({ pinned: false, native: true, integration: null }).map(
      (i) => i.label,
    )
    expect(off.some((l) => l.includes("shell integration"))).toBe(false) // Settings → Off
  })
})
