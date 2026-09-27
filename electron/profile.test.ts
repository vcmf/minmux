import { describe, expect, it } from "vitest"
import { DEFAULT_PROFILE, profileNames, resolveProfile } from "./profile"

describe("resolveProfile", () => {
  it("a dev (unpackaged) build is `dev` by default; an installed one is the default", () => {
    expect(resolveProfile(undefined, false)).toBe("dev")
    expect(resolveProfile(undefined, true)).toBe(DEFAULT_PROFILE)
    expect(resolveProfile("", false)).toBe("dev")
  })

  it("SMTERM_PROFILE picks one, either way", () => {
    expect(resolveProfile("qa", true)).toBe("qa")
    expect(resolveProfile("wt-ssh-2", false)).toBe("wt-ssh-2")
    expect(resolveProfile(" Dev ", true)).toBe("dev") // trimmed, case-folded
  })

  it("`default` / `prod` mean the installed app's (real config, real lock)", () => {
    expect(resolveProfile("default", false)).toBe(DEFAULT_PROFILE)
    expect(resolveProfile("prod", false)).toBe(DEFAULT_PROFILE)
    expect(resolveProfile("PROD", false)).toBe(DEFAULT_PROFILE)
  })

  it("ignores a name that can't be a directory or app id", () => {
    for (const bad of ["../x", "a/b", "a b", "-x", "x".repeat(40), "é", "a.b"]) {
      expect(resolveProfile(bad, false)).toBe("dev")
      expect(resolveProfile(bad, true)).toBe(DEFAULT_PROFILE)
    }
  })
})

describe("profileNames", () => {
  it("the default profile keeps the installed app's names", () => {
    expect(profileNames(DEFAULT_PROFILE)).toEqual({
      appName: "smterm",
      appId: "com.smterm.app",
      label: "",
    })
  })

  it("another profile gets its own dir name, app id and a label", () => {
    expect(profileNames("dev")).toEqual({
      appName: "smterm-dev",
      appId: "com.smterm.app.dev",
      label: "dev",
    })
  })
})
