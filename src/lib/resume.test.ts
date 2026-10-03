import { describe, it, expect } from "vitest"
import { isPosixShell, sessionLabel, withCd, withEnv } from "./resume"

describe("resume helpers", () => {
  it("withCd single-quotes the path (a hook-supplied path can't break out)", () => {
    expect(withCd("/repo", "claude --resume x")).toBe("cd -- '/repo' && claude --resume x")
    expect(withCd("/a'b; rm -rf ~", "c")).toBe("cd -- '/a'\\''b; rm -rf ~' && c")
  })
  it("isPosixShell: zsh/bash/wsl yes; pwsh/powershell/cmd no", () => {
    expect(isPosixShell("/bin/zsh")).toBe(true)
    expect(isPosixShell("wsl.exe")).toBe(true)
    expect(isPosixShell("C:\\\\Program Files\\\\PowerShell\\\\7\\\\pwsh.exe")).toBe(false)
    expect(isPosixShell("cmd.exe")).toBe(false)
    expect(isPosixShell("/opt/homebrew/bin/fish")).toBe(false) // fish quoting differs: no typed cd
    expect(isPosixShell("/usr/local/bin/nu")).toBe(false) // unknown shells get no typed cd
  })
  it("sessionLabel: /rename, else the id's first block", () => {
    expect(sessionLabel({ status: "resume", sessionId: "abc-def", cwd: "/", name: " x " })).toBe(
      "x",
    )
    expect(sessionLabel({ status: "resume", sessionId: "abc-def", cwd: "/" })).toBe("abc")
  })
})

describe("withEnv", () => {
  it("prefixes the env, quoted; leaves out names that aren't env names", () => {
    expect(withEnv({ MINMUX_RESUME_SESSION: "ses_a" }, "opencode --session ses_a")).toBe(
      "MINMUX_RESUME_SESSION='ses_a' opencode --session ses_a",
    )
    expect(withEnv({ "A;rm -rf ~": "x", B: "it's" }, "cmd")).toBe(`B='it'\\''s' cmd`)
    expect(withEnv(undefined, "cmd")).toBe("cmd")
  })
})
