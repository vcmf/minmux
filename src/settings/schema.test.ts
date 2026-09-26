import { describe, it, expect } from "vitest"
import {
  defaultSettings,
  mergeSettings,
  mergeSshSettings,
  validateSshHosts,
  parseSettings,
  serializeSettings,
} from "./schema"

describe("mergeSettings", () => {
  it("returns defaults for empty/garbage input", () => {
    expect(mergeSettings({})).toEqual(defaultSettings)
    expect(mergeSettings(null)).toEqual(defaultSettings)
    expect(mergeSettings("nope")).toEqual(defaultSettings)
    expect(mergeSettings(42)).toEqual(defaultSettings)
  })

  it("merges a partial object over defaults", () => {
    const s = mergeSettings({ theme: "gruvbox", font: { size: 16 } })
    expect(s.theme).toBe("gruvbox")
    expect(s.font.size).toBe(16)
    expect(s.font.family).toBe(defaultSettings.font.family) // untouched
    expect(s.cursorBlink).toBe(defaultSettings.cursorBlink)
  })

  it("shareHistory defaults on and accepts an explicit opt-out", () => {
    expect(mergeSettings({}).shareHistory).toBe(true)
    expect(mergeSettings({ shareHistory: false }).shareHistory).toBe(false)
    expect(mergeSettings({ shareHistory: "no" }).shareHistory).toBe(true) // wrong type → default
  })

  it("shiftEnterNewline defaults on and accepts an opt-out", () => {
    expect(mergeSettings({}).shiftEnterNewline).toBe(true)
    expect(mergeSettings({ shiftEnterNewline: false }).shiftEnterNewline).toBe(false)
  })

  it("renderer defaults to webgl; only 'dom' opts out of GPU", () => {
    expect(mergeSettings({}).renderer).toBe("webgl")
    expect(mergeSettings({ renderer: "dom" }).renderer).toBe("dom")
    expect(mergeSettings({ renderer: "auto" }).renderer).toBe("webgl") // removed mode → default
    expect(mergeSettings({ renderer: true }).renderer).toBe("webgl") // wrong type → default
  })

  it("fileLinks defaults on; openPath defaults to the VS Code template and allows empty", () => {
    expect(mergeSettings({}).fileLinks).toBe(true)
    expect(mergeSettings({}).openPath).toBe("code -g {file}:{line}:{col}")
    expect(mergeSettings({ fileLinks: false }).fileLinks).toBe(false)
    expect(mergeSettings({ openPath: "" }).openPath).toBe("") // "" = OS default, not rejected
    expect(mergeSettings({ openPath: "cursor -g {file}:{line}" }).openPath).toBe(
      "cursor -g {file}:{line}",
    )
  })

  it("falls back per-field on wrong types", () => {
    const s = mergeSettings({ font: { size: "big", ligatures: "yes" }, scrollback: "lots" })
    expect(s.font.size).toBe(defaultSettings.font.size)
    expect(s.font.ligatures).toBe(defaultSettings.font.ligatures)
    expect(s.scrollback).toBe(defaultSettings.scrollback)
  })

  it("clamps numbers into range", () => {
    expect(mergeSettings({ font: { size: 9999 } }).font.size).toBe(72)
    expect(mergeSettings({ font: { size: 1 } }).font.size).toBe(6)
    expect(mergeSettings({ font: { lineHeight: 100 } }).font.lineHeight).toBe(3)
  })

  it("ignores unknown keys and empty strings", () => {
    const s = mergeSettings({ nope: true, theme: "   " })
    expect(s).not.toHaveProperty("nope")
    expect(s.theme).toBe(defaultSettings.theme)
  })
})

describe("parseSettings", () => {
  it("defaults on empty or invalid JSON", () => {
    expect(parseSettings("")).toEqual(defaultSettings)
    expect(parseSettings("   ")).toEqual(defaultSettings)
    expect(parseSettings("{ not json")).toEqual(defaultSettings)
  })

  it("round-trips through serialize", () => {
    const s = mergeSettings({ theme: "catppuccin", appearance: "light", font: { size: 15 } })
    expect(parseSettings(serializeSettings(s))).toEqual(s)
  })

  it("theme is a family: a legacy name maps, an unknown one falls back", () => {
    expect(mergeSettings({ theme: "minimal-dark" }).theme).toBe("minimal")
    expect(mergeSettings({ theme: "solarized" }).theme).toBe("minimal")
  })

  it("appearance accepts dark/light/system and defaults to dark", () => {
    expect(defaultSettings.appearance).toBe("dark")
    expect(mergeSettings({ appearance: "light" }).appearance).toBe("light")
    expect(mergeSettings({ appearance: "system" }).appearance).toBe("system")
    expect(mergeSettings({ appearance: "sepia" }).appearance).toBe("dark")
  })

  it("a variant name selects its family and scheme (explicit appearance wins)", () => {
    expect(mergeSettings({ theme: "catppuccin-latte" })).toMatchObject({
      theme: "catppuccin",
      appearance: "light",
    })
    expect(mergeSettings({ theme: "catppuccin-latte", appearance: "dark" }).appearance).toBe("dark")
  })

  it("resumeAgents: auto (default) | ask | off; bypass restore off by default", () => {
    expect(defaultSettings.resumeAgents).toBe("auto")
    expect(defaultSettings.resumeBypassPermissions).toBe(false)
    expect(mergeSettings({ resumeAgents: "ask" }).resumeAgents).toBe("ask")
    expect(mergeSettings({ resumeAgents: "sometimes" }).resumeAgents).toBe("auto")
  })
})

describe("ssh settings", () => {
  const host = { name: "gpu", target: "ubuntu@10.0.0.12" }

  it("defaults to listing ssh config hosts with connection reuse on", () => {
    expect(defaultSettings.ssh).toEqual({
      fromSshConfig: true,
      reuseConnections: true,
      hidden: [],
      hosts: [],
    })
    expect(mergeSettings({}).ssh).toEqual(defaultSettings.ssh)
    expect(mergeSettings({ ssh: "nope" }).ssh).toEqual(defaultSettings.ssh)
  })

  it("never shares arrays with the defaults", () => {
    const a = mergeSettings({})
    a.ssh.hidden.push("x")
    a.ssh.hosts.push({ name: "x", target: "x", args: [], env: "native" })
    expect(defaultSettings.ssh.hidden).toEqual([])
    expect(defaultSettings.ssh.hosts).toEqual([])
  })

  it("reads the booleans, falling back on wrong types", () => {
    expect(mergeSshSettings({ fromSshConfig: false, reuseConnections: false })).toMatchObject({
      fromSshConfig: false,
      reuseConnections: false,
    })
    expect(mergeSshSettings({ fromSshConfig: "no", reuseConnections: 0 })).toMatchObject({
      fromSshConfig: true,
      reuseConnections: true,
    })
  })

  it("normalizes a valid host (trimmed name, default args and env)", () => {
    expect(validateSshHosts([{ ...host, name: "  gpu  " }]).hosts).toEqual([
      { name: "gpu", target: "ubuntu@10.0.0.12", args: [], env: "native" },
    ])
  })

  it("keeps args and a wsl env", () => {
    const h = { ...host, args: ["-p", "2222"], env: "wsl:Ubuntu-22.04" }
    expect(validateSshHosts([h]).hosts[0]).toEqual({ ...h, name: "gpu" })
    expect(validateSshHosts([{ ...host, env: "native" }]).hosts[0]!.env).toBe("native")
  })

  it("drops hosts with a bad name", () => {
    for (const name of [undefined, "", "   ", 3, "x".repeat(81), "prod\u001b[2J", "a\nb"]) {
      expect(validateSshHosts([{ ...host, name }]).hosts).toEqual([])
    }
  })

  it("drops hosts with a bad target", () => {
    for (const target of [
      undefined,
      "",
      "-oProxyCommand=x",
      "a b",
      "a\tb",
      "a\nb",
      7,
      "x".repeat(256),
    ]) {
      expect(validateSshHosts([{ ...host, target }]).hosts).toEqual([])
    }
  })

  it("drops a host whose args aren't all strings, rather than keeping part of them", () => {
    for (const args of [
      "-p 22",
      ["-p", 22],
      [null],
      ["a\nb"],
      Array(33).fill("-v"),
      ["extra"],
      ["-i", "k", "word"],
      ["-G"],
    ]) {
      expect(validateSshHosts([{ ...host, args }]).hosts).toEqual([])
    }
  })

  it("drops hosts with a malformed env", () => {
    for (const env of ["wsl:", "wsl:Ubuntu 22", "docker:x", 1, "WSL:Ubuntu", "wsl:a;b"]) {
      expect(validateSshHosts([{ ...host, env }]).hosts).toEqual([])
    }
  })

  it("keeps the first of duplicate names and rejects non-objects", () => {
    const r = validateSshHosts([
      null,
      "x",
      { ...host },
      { ...host, target: "other" },
      { name: "b", target: "b" },
    ])
    expect(r.hosts.map((h) => [h.name, h.target])).toEqual([
      ["gpu", "ubuntu@10.0.0.12"],
      ["b", "b"],
    ])
    expect(r.rejected).toEqual([0, 1, 3])
  })

  it("ignores a non-array hosts list and caps how many are used (not stored)", () => {
    expect(mergeSshSettings({ hosts: { a: host } }).hosts).toEqual([])
    const many = Array.from({ length: 600 }, (_, i) => ({ name: `h${i}`, target: `h${i}` }))
    expect(mergeSshSettings({ hosts: many }).hosts).toHaveLength(600)
    const r = validateSshHosts(many)
    expect(r.hosts).toHaveLength(500)
    expect(r.rejected).toHaveLength(100)
  })

  it("keeps hidden as unique non-empty strings", () => {
    expect(mergeSshSettings({ hidden: ["a", "a", "", " ", 3, null, "b"] }).hidden).toEqual([
      "a",
      "b",
    ])
    expect(mergeSshSettings({ hidden: "a" }).hidden).toEqual([])
  })

  it("trims hidden entries so they match trimmed host names", () => {
    expect(mergeSshSettings({ hidden: [" prod ", "prod", " a"] }).hidden).toEqual(["prod", "a"])
  })

  it("caps hidden entries in count and length, and drops control characters", () => {
    const many = Array.from({ length: 1500 }, (_, i) => `h${i}`)
    expect(mergeSshSettings({ hidden: many }).hidden).toHaveLength(1000)
    expect(mergeSshSettings({ hidden: ["x".repeat(256), "ok", "a\u0007b"] }).hidden).toEqual(["ok"])
  })

  it("keeps settings hosts verbatim, including invalid ones, so a save never erases them", () => {
    const raw = [
      { name: "ok", target: "ok" },
      { name: "typo", target: "t", args: ["-N"] },
      { name: "half", target: "t", args: ["-p"] },
      "not even an object",
    ]
    const s = mergeSettings({ ssh: { hosts: raw } })
    expect(s.ssh.hosts).toEqual(raw)
    expect(JSON.parse(serializeSettings(s)).ssh.hosts).toEqual(raw)
    expect(validateSshHosts(s.ssh.hosts)).toEqual({
      hosts: [{ name: "ok", target: "ok", args: [], env: "native" }],
      rejected: [1, 2, 3],
    })
  })

  it("never throws on hosts JSON can't hold (cycles, BigInt)", () => {
    const cyclic: Record<string, unknown> = { name: "a", target: "a" }
    cyclic.self = cyclic
    expect(mergeSshSettings({ hosts: [cyclic] }).hosts).toEqual([])
    expect(mergeSshSettings({ hosts: [{ name: "a", target: "a", n: BigInt(1) }] }).hosts).toEqual(
      [],
    )
    expect(() => mergeSettings({ ssh: { hosts: [cyclic] } })).not.toThrow()
  })

  it("copies the hosts it keeps (no aliasing of the parsed input)", () => {
    const raw = [{ name: "a", target: "a" }]
    const s = mergeSshSettings({ hosts: raw })
    expect(s.hosts).toEqual(raw)
    expect(s.hosts[0]).not.toBe(raw[0])
  })

  it("round-trips through serialize/parse", () => {
    const s = mergeSettings({
      ssh: { reuseConnections: false, hidden: ["x"], hosts: [{ ...host, args: ["-A"] }] },
    })
    expect(parseSettings(serializeSettings(s)).ssh).toEqual(s.ssh)
  })
})
