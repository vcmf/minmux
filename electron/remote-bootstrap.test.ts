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
  REMOTE_ZSHENV,
  remoteBootstrapCommand,
  remoteHooks,
  SMTERM_OSC,
} from "./remote-bootstrap"
import { BASH_HOOKS, ZSH_HOOKS } from "./shell-integration"

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
    for (const rc of [REMOTE_ZSHENV, REMOTE_BASHRC]) {
      expect(rc).not.toContain("\\033]133;")
      expect(rc).not.toContain("\\033]7;")
      expect(rc).toContain(`\\033]${SMTERM_OSC};%s;P;%s;%s\\007' "$__smterm_nonce"`) // the folder
      for (const kind of ["C", "D;%s"]) {
        expect(rc).toContain(`\\033]${SMTERM_OSC};%s;${kind}\\007' "$__smterm_nonce"`)
      }
    }
  })

  it("remoteHooks refuses a script whose emits it doesn't recognise", () => {
    expect(() => remoteHooks(ZSH_HOOKS.replace("133;C", "133;X"), "zsh")).toThrow()
    expect(() => remoteHooks(ZSH_HOOKS, "bash")).toThrow() // bash's OSC 7 names $HOSTNAME
    expect(remoteHooks(BASH_HOOKS, "bash")).toContain(`]${SMTERM_OSC};%s;D;%s`)
  })

  it("leave the host's history alone and remove their temp dir first thing", () => {
    expect(REMOTE_BASHRC).toContain("SMTERM_SHARE_HISTORY=0")
    expect(REMOTE_ZSHENV).not.toMatch(/HISTFILE|SHARE_HISTORY/) // zsh gets the user's own files
    for (const rc of [REMOTE_ZSHENV, REMOTE_BASHRC]) {
      expect(rc.indexOf("rm -rf")).toBeLessThan(rc.indexOf("__smterm_precmd"))
      expect(rc).toMatch(/case "\$\{\w+-\}" in \*\/smterm\.\*\) command rm -rf/) // only ours
    }
  })

  it("zsh: the user's ZDOTDIR is back before any of their files run, and the nonce stays unexported", () => {
    const at = (t: string) => REMOTE_ZSHENV.indexOf(t)
    expect(at("typeset +x __smterm_nonce")).toBeGreaterThan(0)
    expect(at("ZDOTDIR=$SMTERM_USER_ZDOTDIR")).toBeLessThan(
      at('source "${ZDOTDIR:-$HOME}/.zshenv"'),
    )
    expect(at("typeset +x")).toBeLessThan(at("source"))
    expect(PAYLOAD).toContain("SMTERM_USER_ZDOTDIR=${ZDOTDIR-}")
    expect(PAYLOAD).not.toMatch(/\.zshrc|\.zprofile/) // only .zshenv is ours
  })

  it("bash: the nonce stays unexported, and it leaves like a login shell", () => {
    expect(REMOTE_BASHRC.indexOf("export -n __smterm_nonce")).toBeLessThan(
      REMOTE_BASHRC.indexOf("/etc/profile"),
    )
    expect(REMOTE_BASHRC).toContain("logout() {")
    expect(REMOTE_BASHRC).toContain(".bash_logout")
  })

  it("bash reads the files a login bash would", () => {
    const order = ["/etc/profile", ".bash_profile", ".bash_login", ".profile"]
    const at = order.map((f) => REMOTE_BASHRC.indexOf(f))
    expect(at.every((i) => i > 0)).toBe(true)
    expect([...at].sort((a, b) => a - b)).toEqual(at)
  })

  it("start no process at a prompt (the hooks use printf and builtins only)", () => {
    for (const rc of [REMOTE_ZSHENV, REMOTE_BASHRC]) {
      for (const fn of ["__smterm_precmd", "__smterm_preexec", "__smterm_cwd"]) {
        const start = rc.indexOf(`${fn}() {`)
        expect(start).toBeGreaterThan(0)
        const body = rc.slice(start, rc.indexOf("\n}", start) + 2)
        expect(body).not.toMatch(/\$\((?!\()|`/) // $( … ) forks; $(( … )) is arithmetic
      }
    }
  })

  it("are valid bash / zsh", () => {
    expect(syntaxOk("bash", REMOTE_BASHRC)).not.toBe(false)
    expect(syntaxOk("zsh", REMOTE_ZSHENV)).not.toBe(false)
  })
})

describe("the handshake (payload)", () => {
  it("reads past lines typed early and only takes the marked, full-length answer", () => {
    expect(PAYLOAD).toContain('case "$l" in *smterm:*)')
    expect(PAYLOAD).toContain('[ ${#n} -ne 32 ] || [ "$l" != "$n:-" ]')
    expect(PAYLOAD).toContain("stty -echo -icanon -isig") // ^C is data while it waits
  })

  it("says ok only once it took a valid answer", () => {
    const at = (t: string) => PAYLOAD.indexOf(t)
    expect(at(`;ok;%s`)).toBeGreaterThan(at('[ "$l" != "$n:-" ]'))
    expect(at(`;ok;%s`)).toBeLessThan(at('case "${s##*/}" in\n  zsh)'))
  })

  it("drains a late answer before the plain shell, and says it skipped", () => {
    expect(PAYLOAD).toMatch(/if \[ -z "\$a" \]; then stty min 0 time 20/)
    expect(PAYLOAD).toContain(`__smterm_boot || printf '\\033]${SMTERM_OSC};skip;%s`)
  })
})

describe("handshakeReply", () => {
  it("is one line: a marker (keys typed early come before it), the nonce, no folder yet", () => {
    expect(handshakeReply(N)).toBe(`smterm:${N}:-\r`)
    expect(() => handshakeReply("not hex")).toThrow()
  })
})

describe("HelloWatch", () => {
  const ok = `\x1b]${SMTERM_OSC};ok;${C}\x07`
  const skip = `\x1b]${SMTERM_OSC};skip;${C}\x07`

  it("answers the hello once, after the bootstrap booted, and arms on the host's ok", () => {
    const w = new HelloWatch(C, "R")
    expect(w.feed("Welcome to Ubuntu\r\n")).toBeNull()
    expect(w.feed(boot + hello)).toEqual({ write: "R" })
    expect(w.booted).toBe(true)
    expect(w.feed(hello)).toBeNull() // never twice
    expect(w.armed).toBe(false) // not until the host took it
    expect(w.feed("x" + ok + "prompt")).toEqual({ armed: true })
    expect(w.done).toBe(true)
  })

  it("never arms on an ok before its answer, or after a skip (a late answer, a plain shell)", () => {
    const early = new HelloWatch(C, "R")
    expect(early.feed(boot + ok)).toBeNull()
    expect(early.armed).toBe(false)
    const late = new HelloWatch(C, "R")
    late.feed(boot + hello)
    expect(late.feed(skip + ok)).toBeNull()
    expect(late.armed).toBe(false)
    expect(late.done).toBe(true)
  })

  it("finds marks split across chunks", () => {
    const w = new HelloWatch(C, "R")
    const steps = [...("motd…" + boot + "x" + hello)].map((ch) => w.feed(ch)).filter(Boolean)
    expect(steps).toEqual([{ write: "R" }])
    const armed = [...("\r\n" + ok)].map((ch) => w.feed(ch)).filter(Boolean)
    expect(armed).toEqual([{ armed: true }])
  })

  it("ignores marks with another challenge, or before boot (a banner can't trigger it)", () => {
    const w = new HelloWatch(C, "R")
    expect(w.feed(`\x1b]${SMTERM_OSC};boot;0000000000000000\x07`)).toBeNull()
    expect(w.feed(hello)).toBeNull()
    expect(w.booted).toBe(false)
  })

  it("stops at a skip, or soon after boot, or after a lot of output", () => {
    const s1 = new HelloWatch(C, "R")
    s1.feed(boot + skip)
    expect(s1.done).toBe(true)
    expect(s1.feed(hello)).toBeNull()
    const quiet = new HelloWatch(C, "R")
    quiet.feed(boot)
    quiet.feed("x".repeat(70 << 10))
    expect(quiet.done).toBe(true)
    const w = new HelloWatch(C, "R")
    w.feed("x".repeat(2 << 20))
    expect(w.done).toBe(true)
    expect(w.feed(boot + hello)).toBeNull()
  })
})

describe("integrationFailed", () => {
  const end = { booted: false, exitCode: 1, signal: 0, closedBySmterm: false, livedMs: 3000 }
  it("a pane that ended on its own, soon, before the bootstrap booted", () => {
    expect(integrationFailed(end)).toBe(true) // e.g. cmd.exe: 'exec' is not recognized
  })

  it("never for ssh's own failure, a signal, a pane smterm closed, a boot, or a long session", () => {
    expect(integrationFailed({ ...end, exitCode: 255 })).toBe(false) // auth / connection
    expect(integrationFailed({ ...end, exitCode: 0, signal: 1 })).toBe(false) // SIGHUP: closed
    expect(integrationFailed({ ...end, exitCode: 0, signal: 2 })).toBe(false) // ^C at a prompt
    expect(integrationFailed({ ...end, closedBySmterm: true })).toBe(false)
    expect(integrationFailed({ ...end, booted: true })).toBe(false)
    expect(integrationFailed({ ...end, livedMs: 10 * 60_000 })).toBe(false)
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
