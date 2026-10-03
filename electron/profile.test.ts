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

  it("an installed app ignores MINMUX_PROFILE entirely — even an invalid one", () => {
    expect(installed("qa")).toEqual({ profile: DEFAULT_PROFILE })
    expect(installed("wt_1")).toEqual({ profile: DEFAULT_PROFILE })
  })

  it("a dev build takes MINMUX_PROFILE", () => {
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
      expect("error" in fromEnv && fromEnv.error).toContain("MINMUX_PROFILE=")
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
    expect(n).toEqual({ appName: "minmux", label: "" })
    expect(displayName(n)).toBe("minmux")
  })

  it("another profile gets its own dir name and a label", () => {
    const n = profileNames("dev")
    expect(n).toEqual({ appName: "minmux-dev", label: "dev" })
    expect(displayName(n)).toBe("minmux (dev)")
  })
})

describe("scrubParentInstanceEnv", () => {
  it("drops what a parent minmux set for its own pane, and nothing else", () => {
    const env: Record<string, string | undefined> = {
      MINMUX_PROFILE: "dev",
      MINMUX_CLAUDE_SETTINGS: "/home/me/.config/minmux/claude-hooks.json",
      MINMUX_AGENT_EVENTS: "/home/me/.config/minmux/hook-events/n",
      MINMUX_PANE_ID: "p1",
      MINMUX_SHARE_HISTORY: "0",
      MINMUX_ZDOTDIR: "/tmp/minmux/shell-integration/zsh",
      MINMUX_PERF: "1", // a user knob: kept
      PATH: "/usr/bin",
    }
    expect(scrubParentInstanceEnv(env).sort()).toEqual([
      "MINMUX_AGENT_EVENTS",
      "MINMUX_CLAUDE_SETTINGS",
      "MINMUX_PANE_ID",
      "MINMUX_PROFILE",
      "MINMUX_SHARE_HISTORY",
      "MINMUX_ZDOTDIR",
    ])
    expect(env).toEqual({ MINMUX_PERF: "1", PATH: "/usr/bin" })
  })

  it("takes a parent's OpenCode plugin out of the user's inline config, keeping theirs", () => {
    const ours = "file:///home/me/.config/minmux/agents/minmux-opencode.js"
    const env: Record<string, string | undefined> = {
      OPENCODE_CONFIG_CONTENT: JSON.stringify({ model: "m", plugin: ["mine", ours] }),
    }
    expect(scrubParentInstanceEnv(env)).toEqual(["OPENCODE_CONFIG_CONTENT"])
    expect(JSON.parse(env.OPENCODE_CONFIG_CONTENT!)).toEqual({ model: "m", plugin: ["mine"] })
    const onlyOurs: Record<string, string | undefined> = {
      OPENCODE_CONFIG_CONTENT: JSON.stringify({ plugin: [ours] }),
    }
    scrubParentInstanceEnv(onlyOurs)
    expect(onlyOurs).toEqual({})
    const theirs = { OPENCODE_CONFIG_CONTENT: '{"plugin":["mine"]}' }
    expect(scrubParentInstanceEnv(theirs)).toEqual([]) // nothing of a minmux's: untouched
    expect(theirs.OPENCODE_CONFIG_CONTENT).toBe('{"plugin":["mine"]}')
  })

  it("also drops them under the old smterm names (started from an smterm pane)", () => {
    const env: Record<string, string | undefined> = {
      SMTERM_PANE_ID: "p1",
      SMTERM_CLAUDE_SETTINGS: "/home/me/.config/smterm/claude-hooks.json",
      SMTERM_PERF: "1",
    }
    expect(scrubParentInstanceEnv(env).sort()).toEqual(["SMTERM_CLAUDE_SETTINGS", "SMTERM_PANE_ID"])
    expect(env).toEqual({ SMTERM_PERF: "1" })
  })
})
