import { describe, expect, it } from "vitest"
import { SSH_ERRORS } from "./ssh-errors"
import {
  afterStart,
  authPrompt,
  exitReason,
  onOutput,
  remoteStatusUi,
  retryPlan,
  tabRemoteBadge,
  waitingRemoteIds,
  banner,
  cleanError,
  cursorBelowContent,
  firstStart,
  idleMessage,
  isIdle,
  mayBePrompt,
  onKey,
  type RemotePhase,
} from "./remote-connect"

describe("firstStart", () => {
  it("only a restored pane under on-focus waits (and even then reattaches a live one)", () => {
    expect(firstStart(true, "on-focus")).toBe("attach")
    expect(firstStart(true, "auto")).toBe("spawn")
    expect(firstStart(false, "on-focus")).toBe("spawn")
    expect(firstStart(false, "auto")).toBe("spawn")
  })
})

describe("afterStart", () => {
  it("started: false means nothing was live → waiting; otherwise still connecting", () => {
    expect(afterStart("starting", false)).toBe("waiting")
    expect(afterStart("starting", true)).toBe("starting") // "connecting" until ssh prints
    expect(afterStart("starting", undefined)).toBe("starting") // older main / local shape
    expect(afterStart("starting", true, true)).toBe("live") // a reattached ssh is running
  })

  it("never overrides a phase something else already moved it to", () => {
    for (const p of ["live", "prompt", "waiting", "closed", "failed"] as RemotePhase[]) {
      expect(afterStart(p, true)).toBe(p)
      expect(afterStart(p, false)).toBe(p)
    }
  })
})

describe("onKey", () => {
  it("forwards everything while starting or live", () => {
    expect(onKey("live", "x")).toBe("forward")
    expect(onKey("starting", "\r")).toBe("forward")
  })

  it("an idle pane connects on a bare Enter and drops anything else", () => {
    for (const p of ["waiting", "closed", "failed"] as RemotePhase[]) {
      expect(onKey(p, "\r")).toBe("connect")
      expect(onKey(p, "x")).toBe("drop")
      expect(onKey(p, "ls\r")).toBe("drop") // a paste ending in Enter isn't a connect
      expect(onKey(p, "\u001b[A")).toBe("drop")
    }
  })
})

describe("isIdle", () => {
  it("is true only for the prompt phases", () => {
    expect(["waiting", "closed", "failed"].every((p) => isIdle(p as RemotePhase))).toBe(true)
    expect(isIdle("live")).toBe(false)
    expect(isIdle("starting")).toBe(false)
    expect(isIdle(undefined)).toBe(false)
  })
})

describe("idleMessage", () => {
  it("says what happened, then the keys: Enter acts, Esc closes", () => {
    expect(idleMessage("waiting", "gpu")).toBe(
      "gpu isn't connected yet. Enter to connect · Esc twice to close",
    )
    expect(idleMessage("closed", "gpu", { code: 0, signal: 0 })).toBe(
      "Session on gpu ended. Enter to start a new one · Esc twice to close",
    )
    expect(idleMessage("closed", "gpu", { code: 255, signal: 0 })).toBe(
      "Connection to gpu lost (the connection dropped or was refused). Enter to reconnect · Esc twice to close",
    )
    expect(idleMessage("closed", "gpu", { code: 0, signal: 9 })).toBe(
      "Connection to gpu lost (ssh was stopped (signal 9)). Enter to reconnect · Esc twice to close",
    )
  })

  it("matches a failure to what can fix it", () => {
    expect(idleMessage("failed", "gpu", { error: SSH_ERRORS.hostGone })).toBe(
      "gpu isn't in your ssh config any more. Add it back, then Enter to retry · Esc twice to close",
    )
    expect(idleMessage("failed", "gpu", { error: SSH_ERRORS.noSsh })).toBe(
      "ssh isn't installed or isn't on PATH. Install OpenSSH, then Enter to retry · Esc twice to close",
    )
    expect(idleMessage("failed", "gpu", { error: SSH_ERRORS.newerBuild })).toBe(
      `gpu can't be opened here: ${SSH_ERRORS.newerBuild}. Esc twice to close`, // no Enter: it can't work
    )
    expect(idleMessage("failed", "gpu", { error: SSH_ERRORS.wslDown("Ubuntu") })).toBe(
      `${SSH_ERRORS.wslDown("Ubuntu")}. Enter to retry · Esc twice to close`,
    )
    expect(idleMessage("failed", "gpu", { error: "host not listed" })).toBe(
      "couldn't connect to gpu: host not listed. Enter to retry · Esc twice to close",
    )
  })
})

describe("exitReason", () => {
  it("puts ssh's exit in words", () => {
    expect(exitReason(255, 0)).toBe("the connection dropped or was refused")
    expect(exitReason(1, 0)).toBe("ssh exited with code 1")
    expect(exitReason(0, 15)).toBe("ssh was stopped (signal 15)")
  })
})

describe("onOutput", () => {
  it("output makes a connecting pane live and ends a prompt; nothing else moves", () => {
    expect(onOutput("starting")).toBe("live")
    expect(onOutput("prompt")).toBe("live")
    for (const p of ["live", "waiting", "closed", "failed"] as RemotePhase[]) {
      expect(onOutput(p)).toBe(p)
    }
  })
})

describe("onKey — Esc and failures that can't be retried", () => {
  it("Esc twice closes an idle pane; it's an ordinary key in a live one", () => {
    for (const p of ["waiting", "closed", "failed"] as RemotePhase[]) {
      expect(onKey(p, "\u001b")).toBe("arm-close") // the first press only arms it
      expect(onKey(p, "\u001b", undefined, true)).toBe("close")
    }
    expect(onKey("live", "\u001b")).toBe("forward")
    expect(onKey("prompt", "\u001b")).toBe("forward")
    expect(onKey("closed", "\u001b[A")).toBe("drop") // an arrow key isn't Esc
  })

  it("Enter does nothing on a failure no retry can fix", () => {
    expect(onKey("failed", "\r", "not-here")).toBe("drop")
    expect(onKey("failed", "\r", "host-gone")).toBe("connect")
    expect(onKey("failed", "\r", "other")).toBe("connect")
  })
})

describe("authPrompt", () => {
  it("recognises what ssh and common hosts ask for", () => {
    expect(authPrompt("quang@10.0.4.12's password: ")).toBe("password")
    expect(authPrompt("Password:")).toBe("password")
    expect(authPrompt("[sudo] password for quang:")).toBe("password")
    expect(authPrompt("Enter passphrase for key '/Users/me/.ssh/id_ed25519': ")).toBe("passphrase")
    expect(authPrompt("Verification code: ")).toBe("code")
    expect(authPrompt("One-time password (OATH) for `me': ")).toBe("code")
    expect(authPrompt("Enter PIN for ECDSA-SK key /Users/me/.ssh/id_ecdsa_sk:")).toBe("PIN")
    expect(
      authPrompt("Are you sure you want to continue connecting (yes/no/[fingerprint])? "),
    ).toBe("host key")
  })

  it("ignores ordinary lines, including ones that merely mention a password", () => {
    for (const l of [
      "quang@gpu-box:~$ ",
      "password reset email sent",
      "Last login: Sat Sep 27 21:14:02 2026 from 10.0.0.5",
      "",
      "x".repeat(400) + "password:",
    ]) {
      expect(authPrompt(l)).toBeNull()
    }
  })
})

describe("remoteStatusUi", () => {
  it("each state has its own dot and word; live shows the ordinary status", () => {
    expect(remoteStatusUi("starting", "idle")).toEqual({
      dot: "faint",
      word: "connecting",
      pulse: true,
    })
    expect(remoteStatusUi("prompt", "idle", "password").word).toBe("password")
    expect(remoteStatusUi("prompt", "idle").dot).toBe("amber")
    expect(remoteStatusUi("closed", "idle")).toEqual({
      dot: "red",
      word: "disconnected",
      pulse: false,
    })
    expect(remoteStatusUi("failed", "idle").word).toBe("can't connect")
    expect(remoteStatusUi("waiting", "idle")).toEqual({
      dot: "hollow",
      word: "not connected",
      pulse: false,
    })
    expect(remoteStatusUi("live", "working").word).toBe("running")
    expect(remoteStatusUi(undefined, "idle").word).toBe("idle")
  })
})

describe("tabRemoteBadge", () => {
  it("a prompt beats a drop; a clean exit isn't a drop; nothing remote-wrong → null", () => {
    expect(
      tabRemoteBadge([{ phase: "live" }, { phase: "closed", detail: "lost" }, { phase: "prompt" }]),
    ).toBe("prompt")
    expect(tabRemoteBadge([{ phase: "live" }, { phase: "failed", detail: "other" }])).toBe("down")
    expect(tabRemoteBadge([{ phase: "closed", detail: "lost" }])).toBe("down")
    expect(tabRemoteBadge([{ phase: "closed", detail: "ended" }])).toBeNull()
    expect(
      tabRemoteBadge([{ phase: "live" }, {}, { phase: "starting" }, { phase: "waiting" }]),
    ).toBeNull()
    expect(tabRemoteBadge([])).toBeNull()
  })
})

describe("cleanError", () => {
  it("drops Electron's invoke prefix", () => {
    expect(
      cleanError(new Error("Error invoking remote method 'pty:spawn': Error: ssh isn't installed")),
    ).toBe("ssh isn't installed")
  })

  it("replaces control characters (a remote error can't drive the terminal)", () => {
    expect(cleanError("bad\u001b]0;title\u0007 thing\nnext")).toBe("bad ]0;title  thing next")
  })

  it("caps the length and never returns an empty line", () => {
    expect(cleanError("x".repeat(500))).toHaveLength(301)
    expect(cleanError("")).toBe("unknown error")
    expect(cleanError(undefined)).toBe("unknown error")
  })
})

describe("banner", () => {
  it("puts a dim [smterm] line on its own row", () => {
    expect(banner("hi")).toBe("\r\n\u001b[2m[smterm] hi\u001b[0m\r\n")
  })
})

describe("cursorBelowContent", () => {
  it("moves a cursor left above the output down to the last non-blank row", () => {
    // A TUI homed the cursor (row 0) over 10 rows of output; screen top = buffer row 0.
    expect(cursorBelowContent({ lastContentRow: 9, cursorRow: 0, baseY: 0 })).toBe("\u001b[10;1H")
    // Scrolled: rows are absolute, the CSI is screen-relative.
    expect(cursorBelowContent({ lastContentRow: 120, cursorRow: 101, baseY: 100 })).toBe(
      "\u001b[21;1H",
    )
  })

  it("leaves a cursor that's already on or below the output alone", () => {
    expect(cursorBelowContent({ lastContentRow: 9, cursorRow: 9, baseY: 0 })).toBe("")
    expect(cursorBelowContent({ lastContentRow: 9, cursorRow: 12, baseY: 0 })).toBe("")
    expect(cursorBelowContent({ lastContentRow: -1, cursorRow: 0, baseY: 0 })).toBe("")
  })
})

describe("mayBePrompt", () => {
  it("never in a full-screen program, nor on a line the user is typing", () => {
    expect(mayBePrompt({ alternateScreen: true })).toBe(false) // vim on a `password:` line
    expect(mayBePrompt({ alternateScreen: false, lastKey: ":" })).toBe(false) // `if password:`
    expect(mayBePrompt({ alternateScreen: false, lastKey: "d" })).toBe(false)
  })

  it("at login (nothing typed yet) or right after Enter (sudo)", () => {
    expect(mayBePrompt({ alternateScreen: false })).toBe(true)
    expect(mayBePrompt({ alternateScreen: false, lastKey: "\r" })).toBe(true)
    expect(mayBePrompt({ alternateScreen: false, lastKey: "sudo ls\r" })).toBe(true) // a paste
  })
})

describe("idleMessage — WSL hosts", () => {
  it("a WSL host gone from its distro's config doesn't send you to your own ssh config", () => {
    expect(idleMessage("failed", "gpu", { error: SSH_ERRORS.hostGone, wslDistro: "Ubuntu" })).toBe(
      "gpu isn't in Ubuntu's ssh config any more, or the distro was removed. Enter to retry · Esc twice to close",
    )
  })
})

describe("retryPlan", () => {
  const base = {
    enabled: true,
    code: 255,
    signal: 0,
    atPrompt: false,
    liveForMs: 60_000,
    attempt: 0,
  }

  it("an established connection that drops: retry 1 after 2 s", () => {
    expect(retryPlan(base)).toEqual({ attempt: 1, delayMs: 2000 })
  })

  it("a retry that dies straight away continues the sequence, then gives up", () => {
    expect(retryPlan({ ...base, liveForMs: 0, attempt: 1 })).toEqual({ attempt: 2, delayMs: 5000 })
    expect(retryPlan({ ...base, liveForMs: 0, attempt: 2 })).toEqual({ attempt: 3, delayMs: 10000 })
    expect(retryPlan({ ...base, liveForMs: 0, attempt: 3 })).toBeNull()
  })

  it("a retried connection that holds, then drops, gets a fresh budget", () => {
    expect(retryPlan({ ...base, attempt: 3 })).toEqual({ attempt: 1, delayMs: 2000 })
  })

  it("never: turned off, a clean exit, a remote command's code, a signal, at a prompt, or short-lived", () => {
    expect(retryPlan({ ...base, enabled: false })).toBeNull()
    expect(retryPlan({ ...base, code: 0 })).toBeNull()
    expect(retryPlan({ ...base, code: 1 })).toBeNull()
    expect(retryPlan({ ...base, signal: 9 })).toBeNull()
    expect(retryPlan({ ...base, atPrompt: true })).toBeNull()
    expect(retryPlan({ ...base, liveForMs: 5_000 })).toBeNull() // usually an auth failure
  })
})

describe("idleMessage — automatic reconnects", () => {
  it("says when the next try is, and when they ran out", () => {
    expect(idleMessage("closed", "gpu", { code: 255, retry: { attempt: 2, delayMs: 5000 } })).toBe(
      "Connection to gpu lost (the connection dropped or was refused). Reconnecting in 5 s (2/3) · Enter to reconnect now · Esc twice to close",
    )
    expect(idleMessage("closed", "gpu", { code: 255, gaveUp: 3 })).toBe(
      "Couldn't reconnect to gpu after 3 tries. Enter to try again · Esc twice to close",
    )
  })
})

describe("reconnecting status", () => {
  it("reads as reconnecting (amber, pulsing), and isn't a red tab", () => {
    expect(remoteStatusUi("closed", "idle", "retrying")).toEqual({
      dot: "amber",
      word: "reconnecting",
      pulse: true,
    })
    expect(tabRemoteBadge([{ phase: "closed", detail: "retrying" }])).toBeNull()
  })
})

describe("waitingRemoteIds", () => {
  const remote = { hostId: "native:web" }
  it("waiting panes, and restored on-focus ones not started yet; never local or live ones", () => {
    const sessions = {
      a: { id: "a", remote },
      b: { id: "b", remote, restored: true },
      c: { id: "c", remote, restored: true },
      d: { id: "d" },
      e: { id: "e", remote },
    }
    const phases = { a: "waiting", c: "live", e: "closed" } as Record<string, RemotePhase>
    expect(waitingRemoteIds(sessions, phases, "on-focus")).toEqual(["a", "b"])
    expect(waitingRemoteIds(sessions, phases, "auto")).toEqual(["a"])
  })
})
