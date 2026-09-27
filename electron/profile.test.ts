import { describe, expect, it } from "vitest"
import {
  DEFAULT_PROFILE,
  displayName,
  profileNames,
  resolveProfile,
  scrubParentInstanceEnv,
} from "./profile"

describe("resolveProfile", () => {
  it("a dev (unpackaged) build is `dev` by default; an installed one is the default", () => {
    expect(resolveProfile(undefined, false)).toEqual({ profile: "dev" })
    expect(resolveProfile(undefined, true)).toEqual({ profile: DEFAULT_PROFILE })
    expect(resolveProfile("", false)).toEqual({ profile: "dev" })
    expect(resolveProfile("  ", true)).toEqual({ profile: DEFAULT_PROFILE })
  })

  it("SMTERM_PROFILE picks one, either way", () => {
    expect(resolveProfile("qa", true)).toEqual({ profile: "qa" })
    expect(resolveProfile("wt-ssh-2", false)).toEqual({ profile: "wt-ssh-2" })
    expect(resolveProfile(" Dev ", true)).toEqual({ profile: "dev" }) // trimmed, case-folded
  })

  it("`default` / `prod` mean the installed app's (real config, real lock)", () => {
    for (const v of ["default", "prod", "PROD"]) {
      expect(resolveProfile(v, false)).toEqual({ profile: DEFAULT_PROFILE })
    }
  })

  it("an invalid name is an error — never a silent fallback to someone's real data", () => {
    for (const bad of ["../x", "a/b", "a b", "-x", "x".repeat(40), "é", "a.b", "wt_1"]) {
      for (const packaged of [true, false]) {
        const r = resolveProfile(bad, packaged)
        expect("error" in r && r.error).toContain("isn't a valid profile name")
      }
    }
  })
})

describe("profileNames / displayName", () => {
  it("the default profile keeps the installed app's names", () => {
    const n = profileNames(DEFAULT_PROFILE)
    expect(n).toEqual({ appName: "smterm", label: "" })
    expect(displayName(n)).toBe("smterm")
  })

  it("another profile gets its own dir name and a label", () => {
    const n = profileNames("dev")
    expect(n).toEqual({ appName: "smterm-dev", label: "dev" })
    expect(displayName(n)).toBe("smterm (dev)")
  })
})

describe("scrubParentInstanceEnv", () => {
  it("drops what a parent smterm set for its own pane, and nothing else", () => {
    const env: Record<string, string | undefined> = {
      SMTERM_PROFILE: "dev",
      SMTERM_CLAUDE_SETTINGS: "/home/me/.config/smterm/claude-hooks.json",
      SMTERM_PANE_ID: "p1",
      SMTERM_SHARE_HISTORY: "0",
      SMTERM_ZDOTDIR: "/tmp/smterm/shell-integration/zsh",
      SMTERM_PERF: "1", // a user knob: kept
      PATH: "/usr/bin",
    }
    expect(scrubParentInstanceEnv(env).sort()).toEqual([
      "SMTERM_CLAUDE_SETTINGS",
      "SMTERM_PANE_ID",
      "SMTERM_PROFILE",
      "SMTERM_SHARE_HISTORY",
      "SMTERM_ZDOTDIR",
    ])
    expect(env).toEqual({ SMTERM_PERF: "1", PATH: "/usr/bin" })
  })
})
