import { describe, expect, it } from "vitest"
import {
  hasControlChar,
  isSshEnv,
  isSshOptionList,
  isSshTarget,
  parseSshEnv,
  sshArgsSetMux,
  validateSshHosts,
} from "./ssh-validate"

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
  it("accepts aliases, user@host, IPv6 and zone ids", () => {
    for (const t of [
      "web",
      "me@web.example",
      "[::1]",
      "root@10.0.0.1",
      "host_1.example",
      "fe80::1%en0",
      "a+b@h",
    ]) {
      expect(isSshTarget(t)).toBe(true)
    }
  })

  it("rejects options, whitespace, control characters, oversize and non-strings", () => {
    for (const t of [
      "-v",
      "a b",
      "a\u0000b",
      "a\u007fb",
      "",
      "x".repeat(256),
      null,
      {},
      3,
      "$(touch${IFS}/tmp/pwn)@host",
      "`id`@h",
      "a;b",
      "a|b",
      "a'b",
      'a"b',
      "a\\b",
      "ssh://me@web:2222",
      "web\u00a0prod",
    ]) {
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
    for (const args of [
      ["-G"],
      ["-V"],
      ["-O", "exit"],
      ["-Q", "cipher"],
      ["-Z"],
      ["-vG"],
      ["-N"],
      ["-f"],
      ["-n"],
      ["-s"],
      ["-W", "db:5432"],
      ["-AN"],
    ]) {
      expect(isSshOptionList(args)).toBe(false)
    }
  })

  it("rejects non-strings and control characters", () => {
    for (const args of [[1], [null], ["-o", "a\nb"], ["-A\u0000"]])
      expect(isSshOptionList(args)).toBe(false)
  })
})

describe("isSshOptionList: -o keywords", () => {
  it("rejects -o options that never give the pane a shell, in any spelling", () => {
    for (const args of [
      ["-o", "SessionType=none"],
      ["-oSessionType=none"],
      ["-o", "ForkAfterAuthentication=yes"],
      ["-o", "RemoteCommand=true"],
      ["-o", "remotecommand true"],
      ["-o", "StdinNull yes"],
      ["-o", "RequestTTY=no"],
      ["-A", "-o", " SESSIONTYPE = none"],
      ["-o", "=RemoteCommand echo hi"],
      ["-o", '"RemoteCommand" echo hi'],
      ["-o", '"Remote"Command=x'],
    ]) {
      expect(isSshOptionList(args)).toBe(false)
    }
  })

  it("accepts other -o options", () => {
    expect(isSshOptionList(["-o", "ServerAliveInterval=30", "-oForwardAgent=yes"])).toBe(true)
  })
})

describe("sshArgsSetMux", () => {
  it("spots multiplexing set by the args themselves", () => {
    for (const args of [
      ["-M"],
      ["-AM"],
      ["-S", "/tmp/cm"],
      ["-S/tmp/cm"],
      ["-o", "ControlMaster=no"],
      ["-oControlPath=/x/%C"],
      ["-o", "controlpersist 5m"],
      ["-p", "22", "-o", "ControlMaster no"],
      ["-o", "=ControlMaster yes"],
      ["-o", '"ControlPath" /x'],
      ["-F", "/my/config"],
      ["-F/my/config"],
    ]) {
      expect(sshArgsSetMux(args)).toBe(true)
    }
  })

  it("is false otherwise", () => {
    for (const args of [
      undefined,
      [],
      ["-A"],
      ["-p", "22"],
      ["-o", "ServerAliveInterval=5"],
      ["-i", "-M"],
    ]) {
      expect(sshArgsSetMux(args)).toBe(false)
    }
  })
})

describe("validateSshHosts", () => {
  it("returns usable hosts and the indexes it rejected", () => {
    expect(
      validateSshHosts([
        { name: "a", target: "a", args: ["-p", "2222"] },
        { name: "bad", target: "b", args: ["-o", "RemoteCommand=x"] },
        { name: "a", target: "dup" },
      ]),
    ).toEqual({
      hosts: [{ name: "a", target: "a", args: ["-p", "2222"], env: "native" }],
      rejected: [1, 2],
    })
  })

  it("copies args (no aliasing of the settings object)", () => {
    const args = ["-A"]
    expect(validateSshHosts([{ name: "a", target: "a", args }]).hosts[0]!.args).not.toBe(args)
  })
})
