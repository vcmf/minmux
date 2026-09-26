import { describe, expect, it } from "vitest"
import { hasControlChar, isSshEnv, isSshOptionList, isSshTarget, parseSshEnv } from "./ssh-validate"

describe("hasControlChar", () => {
  it("flags C0 controls and DEL only", () => {
    expect(hasControlChar("plain text / é 文")).toBe(false)
    for (const c of ["\u0000", "\n", "\t", "\r", "\u001b", "\u001f", "\u007f"]) {
      expect(hasControlChar(`a${c}b`)).toBe(true)
    }
    expect(hasControlChar("")).toBe(false)
  })
})

describe("isSshTarget", () => {
  it("accepts aliases, user@host and IPv6", () => {
    for (const t of ["web", "me@web.example", "[::1]", "root@10.0.0.1", "host_1.example"]) {
      expect(isSshTarget(t)).toBe(true)
    }
  })

  it("rejects options, whitespace, control characters, oversize and non-strings", () => {
    for (const t of ["-v", "a b", "a\u0000b", "a\u007fb", "", "x".repeat(256), null, {}, 3]) {
      expect(isSshTarget(t)).toBe(false)
    }
  })
})

describe("parseSshEnv / isSshEnv", () => {
  it("parses native and wsl envs", () => {
    expect(parseSshEnv("native")).toEqual({ kind: "native" })
    expect(parseSshEnv("wsl:Ubuntu-22.04")).toEqual({ kind: "wsl", distro: "Ubuntu-22.04" })
    expect(isSshEnv("wsl:Debian")).toBe(true)
  })

  it("rejects malformed envs and non-strings", () => {
    for (const e of [
      "",
      "wsl:",
      "wsl:Ubuntu; rm -rf",
      "WSL:Ubuntu",
      "docker:x",
      "wsl:a b",
      null,
      1,
    ]) {
      expect(parseSshEnv(e)).toBeNull()
      expect(isSshEnv(e)).toBe(false)
    }
  })
})

describe("isSshOptionList", () => {
  it("accepts flags, clusters, and options with attached or separate values", () => {
    for (const args of [
      [],
      ["-A"],
      ["-p", "2222"],
      ["-p2222"],
      ["-AXv"],
      ["-Ai", "~/.ssh/k"],
      ["-o", "SetEnv=A=b c", "-J", "bastion"],
      ["-i", "-weird-but-a-value"],
      ["-4", "-C", "-L", "8080:localhost:80"],
    ]) {
      expect(isSshOptionList(args)).toBe(true)
    }
  })

  it("rejects bare words (they'd become the destination) and missing values", () => {
    for (const args of [
      ["extra"],
      ["-i", "~/.ssh/k", "extra"],
      [""],
      ["-p"],
      ["-Ap"],
      ["-"],
      ["--"],
      ["host", "-v"],
    ]) {
      expect(isSshOptionList(args)).toBe(false)
    }
  })

  it("rejects options that don't start a session and unknown letters", () => {
    for (const args of [["-G"], ["-V"], ["-O", "exit"], ["-Q", "cipher"], ["-Z"], ["-vG"]]) {
      expect(isSshOptionList(args)).toBe(false)
    }
  })

  it("rejects non-strings and control characters", () => {
    for (const args of [[1], [null], ["-o", "a\nb"], ["-A\u0000"]])
      expect(isSshOptionList(args)).toBe(false)
  })
})
