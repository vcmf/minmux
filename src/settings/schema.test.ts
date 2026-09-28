import { describe, it, expect } from "vitest"
import {
  defaultSettings,
  mergeSettings,
  mergeSshSettings,
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
  it("defaults: nothing hidden, a 30 s keepalive, reconnect at once", () => {
    expect(defaultSettings.ssh).toEqual({
      hidden: [],
      keepAliveSeconds: 30,
      restore: "auto",
      colors: {},
    })
    expect(mergeSettings({}).ssh).toEqual(defaultSettings.ssh)
    expect(mergeSettings({ ssh: "nope" }).ssh).toEqual(defaultSettings.ssh)
  })

  it("reads the block through mergeSettings", () => {
    expect(
      mergeSettings({
        ssh: {
          hidden: ["github.com"],
          keepAliveSeconds: 0,
          restore: "on-focus",
          colors: { "prod-*": "red" },
        },
      }).ssh,
    ).toEqual({
      hidden: ["github.com"],
      keepAliveSeconds: 0,
      restore: "on-focus",
      colors: { "prod-*": "red" },
    })
  })

  it("defaultSettings.ssh has its own arrays (mutating it can't leak into later merges)", () => {
    const hidden = defaultSettings.ssh.hidden
    hidden.push("leak")
    try {
      expect(mergeSettings({}).ssh.hidden).toEqual([])
      expect(mergeSshSettings({}).hidden).toEqual([])
    } finally {
      hidden.pop()
    }
  })

  it("drops keys from older builds (hosts, reuseConnections, fromSshConfig)", () => {
    const s = mergeSettings({
      ssh: { hosts: [{ name: "x" }], reuseConnections: true, fromSshConfig: false },
    })
    expect(s.ssh).toEqual(defaultSettings.ssh)
  })

  it("round-trips through serialize/parse", () => {
    const s = mergeSettings({ ssh: { hidden: ["x"], keepAliveSeconds: 45 } })
    expect(parseSettings(serializeSettings(s)).ssh).toEqual(s.ssh)
  })
})
