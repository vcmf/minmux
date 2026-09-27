import { describe, expect, it } from "vitest"
import {
  DEFAULT_PROFILE,
  displayName,
  profileNames,
  resolveProfile,
  scrubParentInstanceEnv,
} from "./profile"

describe("resolveProfile", () => {
  const dev = (env?: string, flag?: string) => resolveProfile({ env, flag, packaged: false })
  const installed = (env?: string, flag?: string) => resolveProfile({ env, flag, packaged: true })

  it("a dev (unpackaged) build is `dev` by default; an installed one is the default", () => {
    expect(dev()).toEqual({ profile: "dev" })
    expect(installed()).toEqual({ profile: DEFAULT_PROFILE })
    expect(dev("  ")).toEqual({ profile: "dev" })
  })

  it("an installed app ignores SMTERM_PROFILE entirely — even an invalid one", () => {
    expect(installed("qa")).toEqual({ profile: DEFAULT_PROFILE })
    expect(installed("wt_1")).toEqual({ profile: DEFAULT_PROFILE })
  })

  it("a dev build takes SMTERM_PROFILE", () => {
    expect(dev("wt-ssh-2")).toEqual({ profile: "wt-ssh-2" })
    expect(dev(" Dev ")).toEqual({ profile: "dev" }) // trimmed, case-folded
  })

  it("--profile= picks one for either build, and wins over the env", () => {
    expect(installed(undefined, "qa")).toEqual({ profile: "qa" })
    expect(dev("wt1", "qa")).toEqual({ profile: "qa" })
    expect(installed("qa", "default")).toEqual({ profile: DEFAULT_PROFILE })
  })

  it("`default` / `prod` mean the installed app's (real config, real lock)", () => {
    for (const v of ["default", "prod", "PROD"]) {
      expect(dev(v)).toEqual({ profile: DEFAULT_PROFILE })
      expect(installed(undefined, v)).toEqual({ profile: DEFAULT_PROFILE })
    }
  })

  it("an invalid name is an error naming its source — never a silent fallback", () => {
    for (const bad of ["../x", "a/b", "a b", "-x", "x".repeat(40), "é", "a.b", "wt_1"]) {
      const fromEnv = dev(bad)
      expect("error" in fromEnv && fromEnv.error).toContain("SMTERM_PROFILE=")
      for (const r of [dev(undefined, bad), installed(undefined, bad)]) {
        expect("error" in r && r.error).toContain("--profile=")
      }
    }
  })

  it("an empty --profile= is an error too (it was passed, just without a name)", () => {
    const r = installed(undefined, "")
    expect("error" in r && r.error).toContain("isn't a valid profile name")
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
