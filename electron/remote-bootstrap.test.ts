import { execFileSync } from "node:child_process"
import fs from "node:fs"
import { describe, expect, it } from "vitest"
import {
  HelloWatch,
  handshakeReply,
  hasRemoteCommand,
  integrationFailed,
  PAYLOAD,
  REMOTE_BASHRC,
  REMOTE_ZSHRC,
  remoteBootstrapCommand,
  remoteHooks,
  SMTERM_OSC,
} from "./remote-bootstrap"
import { BASH_HOOKS, ZSH_ZSHRC } from "./shell-integration"

const C = "c0ffee00c0ffee00"
const N = "ab".repeat(16)
const hello = `\x1b]${SMTERM_OSC};hello;${C}\x07`
const boot = `\x1b]${SMTERM_OSC};boot;${C}\x07`

/** Syntax-check a script with a shell, if this machine has it (CI images may not have zsh). */
function syntaxOk(shell: string, script: string): boolean | "skipped" {
  if (!["/bin/" + shell, "/usr/bin/" + shell].some((p) => fs.existsSync(p))) return "skipped"
  try {
    execFileSync(shell, ["-n"], { input: script, stdio: ["pipe", "ignore", "pipe"] })
    return true
  } catch {
    return false
  }
}

describe("remoteBootstrapCommand", () => {
  const cmd = remoteBootstrapCommand(C)

  it("is one single-quoted word for sh, with nothing any login shell would touch inside", () => {
    const m = /^exec sh -c '([^']*)'$/.exec(cmd)
    expect(m).not.toBeNull()
    // No quote, backslash, `!` (csh history) or newline: the same text in bash, zsh, fish, csh.
    expect(m![1]).toMatch(/^[A-Za-z0-9+/=:;$(){}|*?_ %.>-]+$/)
  })

  it("carries only the challenge and the fixed script: no nonce, nothing per user", () => {
    expect(cmd).toContain(`S=${C};`)
    expect(cmd).not.toContain(N)
    expect(remoteBootstrapCommand("0123456789abcdef").replace("0123456789abcdef", C)).toBe(cmd)
  })

  it("refuses a challenge that isn't hex", () => {
    for (const bad of ["", "c0ffee'; rm -rf ~", "C0FFEE00C0FFEE00", "abc"]) {
      expect(() => remoteBootstrapCommand(bad)).toThrow()
    }
  })

  it("its payload is the bootstrap, marked so a mangled decode never runs", () => {
    const b64 = /;B=([A-Za-z0-9+/=]+);/.exec(cmd)![1]!
    const payload = Buffer.from(b64, "base64").toString("utf8")
    expect(payload).toBe(PAYLOAD)
    expect(payload.startsWith(": smterm\n")).toBe(true)
    expect(cmd).toContain("case $p in :?smterm*) eval $p;; esac")
  })

  it("is valid sh, and so is its payload", () => {
    expect(syntaxOk("sh", /^exec sh -c '(.*)'$/.exec(cmd)![1]!)).toBe(true)
    expect(syntaxOk("sh", PAYLOAD)).toBe(true)
  })
})

describe("the remote scripts", () => {
  it("tag every report with the nonce, and send no standard (untagged) one", () => {
    for (const rc of [REMOTE_ZSHRC, REMOTE_BASHRC]) {
      expect(rc).not.toContain("\\033]133;")
      expect(rc).not.toContain("\\033]7;")
      for (const kind of ["C", "D;%s", "7;file://%s%s"]) {
        expect(rc).toContain(`\\033]${SMTERM_OSC};%s;${kind}\\007' "$__smterm_nonce"`)
      }
    }
  })

  it("remoteHooks refuses a script whose emits it doesn't recognise", () => {
    expect(() => remoteHooks(ZSH_ZSHRC.replace("133;C", "133;X"))).toThrow()
    expect(remoteHooks(BASH_HOOKS)).toContain(`]${SMTERM_OSC};%s;D;%s`)
  })

  it("leave the host's history alone and remove their temp dir first thing", () => {
    for (const rc of [REMOTE_ZSHRC, REMOTE_BASHRC]) {
      expect(rc).toContain("SMTERM_SHARE_HISTORY=0")
      expect(rc.indexOf("rm -rf")).toBeLessThan(rc.indexOf("__smterm_precmd"))
      expect(rc).toMatch(/case "\$\{\w+-\}" in \*\/smterm\.\*\) command rm -rf/) // only ours
    }
  })

  it("bash reads the files a login bash would", () => {
    const order = ["/etc/profile", ".bash_profile", ".bash_login", ".profile"]
    const at = order.map((f) => REMOTE_BASHRC.indexOf(f))
    expect(at.every((i) => i > 0)).toBe(true)
    expect([...at].sort((a, b) => a - b)).toEqual(at)
  })

  it("start no process at a prompt (the hooks use printf and builtins only)", () => {
    for (const rc of [REMOTE_ZSHRC, REMOTE_BASHRC]) {
      for (const fn of ["__smterm_precmd", "__smterm_preexec"]) {
        const start = rc.indexOf(`${fn}() {`)
        expect(start).toBeGreaterThan(0)
        const body = rc.slice(start, rc.indexOf("\n}", start) + 2)
        expect(body).not.toMatch(/\$\(|`/)
      }
    }
  })

  it("are valid bash / zsh", () => {
    expect(syntaxOk("bash", REMOTE_BASHRC)).not.toBe(false)
    expect(syntaxOk("zsh", REMOTE_ZSHRC)).not.toBe(false)
  })
})

describe("handshakeReply", () => {
  it("is one line: a marker (keys typed early come before it), the nonce, no folder yet", () => {
    expect(handshakeReply(N)).toBe(`smterm:${N}:-\r`)
    expect(() => handshakeReply("not hex")).toThrow()
  })
})

describe("HelloWatch", () => {
  it("answers the hello once, after the bootstrap booted", () => {
    const w = new HelloWatch(C, "R")
    expect(w.feed("Welcome to Ubuntu\r\n")).toBeNull()
    expect(w.feed(boot + hello)).toBe("R")
    expect(w.booted).toBe(true)
    expect(w.feed(hello)).toBeNull()
  })

  it("finds markers split across chunks", () => {
    const w = new HelloWatch(C, "R")
    const all = "motd…" + boot + "x" + hello + "prompt"
    const got = [...all].map((ch) => w.feed(ch)).filter(Boolean)
    expect(got).toEqual(["R"])
  })

  it("ignores a hello with another challenge, or before boot (a banner can't trigger it)", () => {
    const w = new HelloWatch(C, "R")
    expect(w.feed(`\x1b]${SMTERM_OSC};boot;0000000000000000\x07`)).toBeNull()
    expect(w.feed(hello)).toBeNull()
    expect(w.booted).toBe(false)
  })

  it("stops looking after a lot of output", () => {
    const w = new HelloWatch(C, "R")
    w.feed("x".repeat(2 << 20))
    expect(w.done).toBe(true)
    expect(w.feed(boot + hello)).toBeNull()
  })
})

describe("integrationFailed", () => {
  it("only when the bootstrap never ran and ssh itself didn't fail", () => {
    expect(integrationFailed(false, 1)).toBe(true) // e.g. cmd.exe: 'exec' is not recognized
    expect(integrationFailed(false, 255)).toBe(false) // auth / connection
    expect(integrationFailed(true, 0)).toBe(false) // ran (even if it chose a plain shell)
  })
})

describe("hasRemoteCommand", () => {
  it("reads ssh -G's remotecommand line (absent or none = no command)", () => {
    expect(hasRemoteCommand("user me\nremotecommand tmux a\nport 22\n")).toBe(true)
    expect(hasRemoteCommand("user me\nport 22\n")).toBe(false)
    expect(hasRemoteCommand("remotecommand none\n")).toBe(false)
    expect(hasRemoteCommand("RemoteCommand exec zsh\n")).toBe(true)
  })
})
