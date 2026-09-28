import { beforeEach, describe, expect, it, vi } from "vitest"
import { useStore } from "../store"
import { ipc } from "../lib/ipc"
import { resetStore, testHost, testShell } from "../test/helpers"
import { hostShellOption } from "../lib/ssh-hosts-ui"
import { SSH_ERRORS } from "../lib/ssh-errors"
import type { Session } from "../types"

// A stand-in xterm: records writes and exposes the onData handler (jsdom has no canvas).
const terms: FakeTerminal[] = []
class FakeTerminal {
  cols = 80
  rows = 24
  written = ""
  dataHandlers: ((d: string) => void)[] = []
  parser = { registerOscHandler: () => ({ dispose() {} }) }
  buffer = {
    active: {
      type: "normal" as "normal" | "alternate",
      length: 0,
      baseY: 0,
      cursorY: 0,
      getLine: (): { translateToString: (t: boolean) => string } | undefined => undefined,
    },
  }
  modes = { mouseTrackingMode: "none" }
  options = {}
  textarea = document.createElement("textarea")
  constructor() {
    terms.push(this)
  }
  loadAddon() {}
  attachCustomKeyEventHandler() {}
  open() {}
  onData(cb: (d: string) => void) {
    this.dataHandlers.push(cb)
    return { dispose() {} }
  }
  onTitleChange() {
    return { dispose() {} }
  }
  onBell() {
    return { dispose() {} }
  }
  registerLinkProvider() {
    return { dispose() {} }
  }
  registerCharacterJoiner() {
    return 1
  }
  deregisterCharacterJoiner() {}
  write(s: string, cb?: () => void) {
    this.written += s
    cb?.()
  }
  type(d: string) {
    for (const h of this.dataHandlers) h(d)
  }
  resize() {}
  refresh() {}
  focus() {}
  hasSelection() {
    return false
  }
  dispose() {}
}
vi.mock("@xterm/xterm", () => ({ Terminal: FakeTerminal }))
vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    fit() {}
  },
}))
vi.mock("@xterm/addon-web-links", () => ({ WebLinksAddon: class {} }))
vi.mock("@xterm/addon-webgl", () => ({ WebglAddon: class {} }))
vi.mock("@xterm/addon-search", () => ({ SearchAddon: class {} }))

const { TerminalManager } = await import("./terminal-manager")

const st = () => useStore.getState()
const flush = () => new Promise((r) => setTimeout(r, 0))

let exitHandlers: Record<string, (e: { code: number; signal: number }) => void>
let dataHandlers: Record<string, (d: string) => void>
/** PTY output for a session (what main would send on pty:data:<id>). */
const out = (id: string, d: string) => dataHandlers[id]?.(d)

beforeEach(() => {
  resetStore()
  vi.clearAllMocks()
  terms.length = 0
  exitHandlers = {}
  dataHandlers = {}
  vi.mocked(ipc.onPtyData).mockImplementation((id, cb) => {
    dataHandlers[id] = cb as (d: string) => void
    return () => delete dataHandlers[id]
  })
  vi.mocked(ipc.onPtyExit).mockImplementation((id, cb) => {
    exitHandlers[id] = cb
    return () => delete exitHandlers[id]
  })
  vi.mocked(ipc.ptySpawn).mockResolvedValue({ reattached: false, integrated: false })
})

/** A remote session in the store (restored or not), started the way a pane starts it. */
function start(opts: { restored?: boolean; restore?: "auto" | "on-focus"; local?: boolean }) {
  if (opts.restore) {
    const settings = st().settings
    useStore.setState({
      settings: { ...settings, ssh: { ...settings.ssh, restore: opts.restore } },
    })
  }
  st().newTab(opts.local ? testShell : hostShellOption(testHost("web")))
  const id = st().tabs[st().tabs.length - 1]!.activeSessionId
  if (opts.restored) {
    useStore.setState((s) => ({
      sessions: { ...s.sessions, [id]: { ...s.sessions[id]!, restored: true } },
    }))
  }
  const session = st().sessions[id] as Session
  TerminalManager.ensureRunning(session)
  return { id, term: terms[terms.length - 1]! }
}

const spawnCalls = () => vi.mocked(ipc.ptySpawn).mock.calls.map((c) => c[0])

describe("TerminalManager — ssh restore", () => {
  it("auto: a restored ssh pane connects at once", async () => {
    start({ restored: true, restore: "auto" })
    expect(spawnCalls()).toHaveLength(1)
    expect(spawnCalls()[0]!.attachOnly).toBeUndefined()
    expect(spawnCalls()[0]!.remote?.hostId).toBe("native:web")
  })

  it("on-focus: only reattaches; with nothing live it waits for Enter", async () => {
    vi.mocked(ipc.ptySpawn).mockResolvedValueOnce({ reattached: false, started: false })
    const { id, term } = start({ restored: true, restore: "on-focus" })
    expect(spawnCalls()[0]!.attachOnly).toBe(true)
    await flush()
    expect(term.written).toContain("web isn't connected yet. Enter to connect · Esc twice to close")
    expect(st().remotePhase[id]).toBe("waiting")

    term.type("ls\r") // not a bare Enter: dropped, never sent to a host that isn't there
    term.type("x")
    expect(ipc.ptyWrite).not.toHaveBeenCalled()
    expect(spawnCalls()).toHaveLength(1)

    term.type("\r")
    expect(spawnCalls()).toHaveLength(2)
    expect(spawnCalls()[1]!.attachOnly).toBeUndefined()
    expect(spawnCalls()[1]!.id).toBe(id) // the same session id
    expect(ipc.ptyWrite).not.toHaveBeenCalled() // the Enter that connected isn't forwarded
    expect(st().remotePhase[id]).toBe("starting")
    await flush()
    term.type("x")
    expect(ipc.ptyWrite).toHaveBeenCalledWith(id, "x")
  })

  it("on-focus after a reload: a live ssh is simply reattached", async () => {
    vi.mocked(ipc.ptySpawn).mockResolvedValueOnce({ reattached: true })
    const { id, term } = start({ restored: true, restore: "on-focus" })
    await flush()
    expect(term.written).not.toContain("press Enter")
    expect(st().remotePhase[id]).toBe("live")
    term.type("x")
    expect(ipc.ptyWrite).toHaveBeenCalledWith(id, "x")
  })

  it("on-focus only applies to restored panes: a new one connects at once", () => {
    start({ restore: "on-focus" })
    expect(spawnCalls()[0]!.attachOnly).toBeUndefined()
  })

  it("never uses attachOnly for a local shell", () => {
    start({ restored: true, restore: "on-focus", local: true })
    expect(spawnCalls()[0]!.attachOnly).toBeUndefined()
    expect(ipc.onPtyExit).not.toHaveBeenCalled()
  })
})

describe("TerminalManager — ssh exit and reconnect", () => {
  it("a dropped connection says so, drops keys, and Enter reconnects the same id", async () => {
    const { id, term } = start({})
    await flush()
    exitHandlers[id]!({ code: 255, signal: 0 })
    expect(term.written).toContain(
      "Connection to web lost (the connection dropped or was refused). Enter to reconnect · Esc twice to close",
    )
    expect(st().remotePhase[id]).toBe("closed")
    term.type("q")
    expect(ipc.ptyWrite).not.toHaveBeenCalled()
    term.type("\r")
    expect(spawnCalls()).toHaveLength(2)
    expect(spawnCalls()[1]!.id).toBe(id)
    expect(term.written).toContain("connecting to web…")
    await flush()
    // One input listener across the respawn: a key reaches the PTY exactly once.
    term.type("a")
    expect(vi.mocked(ipc.ptyWrite).mock.calls).toEqual([[id, "a"]])
    expect(ipc.onPtyData).toHaveBeenCalledTimes(1)
  })

  it("`exit` on the host reads as the session ending", async () => {
    const { id, term } = start({})
    await flush()
    exitHandlers[id]!({ code: 0, signal: 0 })
    expect(term.written).toContain(
      "Session on web ended. Enter to start a new one · Esc twice to close",
    )
  })

  it("a refused spawn shows why, and Enter (or Connect) retries", async () => {
    vi.mocked(ipc.ptySpawn).mockRejectedValueOnce(
      new Error("Error invoking remote method 'pty:spawn': Error: ssh isn't installed\u001b[2J"),
    )
    const { id, term } = start({})
    await flush()
    expect(term.written).toContain("couldn't connect to web: ssh isn't installed [2J")
    expect(term.written).not.toContain("\u001b[2J")
    expect(term.written).not.toContain("[spawn error]")
    expect(st().remotePhase[id]).toBe("failed")
    TerminalManager.connect(id)
    expect(spawnCalls()).toHaveLength(2)
    TerminalManager.connect(id) // already connecting: no second spawn
    expect(spawnCalls()).toHaveLength(2)
  })

  it("an answer for a start that's been superseded is ignored", async () => {
    let resolveFirst: (v: { reattached: boolean }) => void = () => {}
    vi.mocked(ipc.ptySpawn).mockImplementationOnce(() => new Promise((r) => (resolveFirst = r)))
    const { id, term } = start({})
    exitHandlers[id]!({ code: 255, signal: 0 }) // (an exit can't really precede its start's answer)
    resolveFirst({ reattached: false })
    await flush()
    expect(st().remotePhase[id]).toBe("closed")
    term.type("x")
    expect(ipc.ptyWrite).not.toHaveBeenCalled()
  })

  it("a pane closed while connecting writes nothing to the store", async () => {
    let resolveFirst: (v: { reattached: boolean; started: boolean }) => void = () => {}
    vi.mocked(ipc.ptySpawn).mockImplementationOnce(() => new Promise((r) => (resolveFirst = r)))
    const { id } = start({ restored: true, restore: "on-focus" })
    TerminalManager.dispose(id)
    resolveFirst({ reattached: false, started: false })
    await flush()
    expect(st().remotePhase[id]).not.toBe("waiting") // the late answer changed nothing
    expect(exitHandlers[id]).toBeUndefined() // the exit listener went with it
  })

  it("an exit for a local shell changes nothing (only ssh panes reconnect)", async () => {
    const { term } = start({ local: true })
    await flush()
    term.type("x")
    expect(ipc.ptyWrite).toHaveBeenCalledTimes(1)
  })
})

describe("TerminalManager — what a dropped connection leaves behind", () => {
  it("resets the modes a TUI left on (mouse, focus events, paste, cursor keys)", async () => {
    const { id, term } = start({})
    await flush()
    exitHandlers[id]!({ code: 255, signal: 0 })
    for (const m of ["?1000l", "?1002l", "?1003l", "?1006l", "?1004l", "?2004l", "?1l", "?25h"]) {
      expect(term.written).toContain(`\x1b[${m}`)
    }
  })

  it("on the normal screen, never sends ?1049l (it would move the banner into old scrollback)", async () => {
    const { id, term } = start({})
    await flush()
    exitHandlers[id]!({ code: 255, signal: 0 })
    expect(term.written).not.toContain("\x1b[?1049l")
  })

  it("in a TUI's alt screen, leaves it before the banner", async () => {
    const { id, term } = start({})
    await flush()
    term.buffer.active.type = "alternate"
    exitHandlers[id]!({ code: 255, signal: 0 })
    expect(term.written).toContain("\x1b[?1049l")
    expect(term.written.indexOf("\x1b[?1049l")).toBeLessThan(term.written.indexOf("[smterm]"))
  })

  it("ends a 'running' status (nothing runs in a closed pane)", async () => {
    const { id } = start({})
    await flush()
    st().signalSession(id, { type: "command-start" })
    expect(st().sessions[id]!.running).toBe(true)
    exitHandlers[id]!({ code: 255, signal: 0 })
    expect(st().sessions[id]!.running).toBeFalsy()
  })

  it("the store follows the phase: starting → live → closed → starting", async () => {
    const { id, term } = start({})
    expect(st().remotePhase[id]).toBe("starting")
    await flush()
    expect(st().remotePhase[id]).toBe("starting") // spawned, but ssh hasn't printed: connecting
    out(id, "Welcome")
    expect(st().remotePhase[id]).toBe("live")
    exitHandlers[id]!({ code: 255, signal: 0 })
    expect(st().remotePhase[id]).toBe("closed")
    term.type("\r")
    expect(st().remotePhase[id]).toBe("starting")
  })

  it("a start for a session the store doesn't hold yet still spawns (the one given is used)", () => {
    TerminalManager.ensureRunning({
      id: "not-in-store",
      title: "",
      command: "/bin/sh",
      args: [],
      status: "idle",
      unread: false,
    })
    expect(spawnCalls().map((c) => c.id)).toContain("not-in-store")
  })
})

describe("TerminalManager — ssh prompts, closing, failures", () => {
  /** Make the fake terminal's cursor line read `text`. */
  const cursorLine = (term: FakeTerminal, text: string) => {
    term.buffer.active.getLine = () => ({ translateToString: () => text })
  }

  it("a password prompt after output goes quiet shows as a prompt; the next output ends it", async () => {
    vi.useFakeTimers()
    try {
      const { id, term } = start({})
      await vi.advanceTimersByTimeAsync(0)
      out(id, "quang@10.0.4.12's password: ")
      cursorLine(term, "quang@10.0.4.12's password: ")
      expect(st().remotePhase[id]).toBe("live")
      await vi.advanceTimersByTimeAsync(1300) // the output-idle timer
      expect(st().remotePhase[id]).toBe("prompt")
      expect(st().remoteDetail[id]).toBe("password")
      term.type("hunter2\r") // still goes to ssh: a prompt is live
      expect(ipc.ptyWrite).toHaveBeenCalledWith(id, "hunter2\r")
      out(id, "\r\nWelcome to Ubuntu")
      expect(st().remotePhase[id]).toBe("live")
      expect(st().remoteDetail[id]).toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })

  it("an off-screen prompt raises attention (the bell and the background notification)", async () => {
    vi.useFakeTimers()
    try {
      const { id, term } = start({})
      st().newTab(testShell) // another tab in front: the ssh pane is off-screen
      await vi.advanceTimersByTimeAsync(0)
      out(id, "Verification code: ")
      cursorLine(term, "Verification code: ")
      await vi.advanceTimersByTimeAsync(1300)
      expect(st().remoteDetail[id]).toBe("code")
      expect(st().sessions[id]!.status).toBe("attention")
      expect(st().sessions[id]!.detail).toBe("web asks for a code")
    } finally {
      vi.useRealTimers()
    }
  })

  it("an ordinary shell prompt going quiet is not a prompt", async () => {
    vi.useFakeTimers()
    try {
      const { id, term } = start({})
      await vi.advanceTimersByTimeAsync(0)
      out(id, "quang@gpu-box:~$ ")
      cursorLine(term, "quang@gpu-box:~$ ")
      await vi.advanceTimersByTimeAsync(1300)
      expect(st().remotePhase[id]).toBe("live")
    } finally {
      vi.useRealTimers()
    }
  })

  it("Esc twice closes a disconnected pane; once only asks (vim habit right after a drop)", async () => {
    const { id, term } = start({})
    await flush()
    out(id, "hi")
    exitHandlers[id]!({ code: 255, signal: 0 })
    term.type("\u001b")
    await flush()
    expect(st().sessions[id]).toBeDefined()
    expect(term.written).toContain("Press Esc again to close this pane.")
    term.type("\u001b")
    await flush() // the close waits for the key event to unwind
    expect(st().sessions[id]).toBeUndefined() // App then disposes its terminal (kills the PTY)
  })

  it("a first Esc goes stale: a second one much later only asks again", async () => {
    vi.useFakeTimers()
    try {
      const { id, term } = start({})
      await vi.advanceTimersByTimeAsync(0)
      exitHandlers[id]!({ code: 255, signal: 0 })
      term.type("\u001b")
      await vi.advanceTimersByTimeAsync(3000)
      term.type("\u001b")
      await vi.advanceTimersByTimeAsync(10)
      expect(st().sessions[id]).toBeDefined()
    } finally {
      vi.useRealTimers()
    }
  })

  it("a clean exit records `ended`; a drop `lost`", async () => {
    const { id } = start({})
    await flush()
    exitHandlers[id]!({ code: 0, signal: 0 })
    expect(st().remoteDetail[id]).toBe("ended")
    const b = start({})
    await flush()
    exitHandlers[b.id]!({ code: 255, signal: 0 })
    expect(st().remoteDetail[b.id]).toBe("lost")
  })

  it("no prompt for a line the user is typing, nor in a full-screen program", async () => {
    vi.useFakeTimers()
    try {
      const { id, term } = start({})
      await vi.advanceTimersByTimeAsync(0)
      out(id, "quang@gpu-box:~$ ")
      term.type("i") // typed; the echo arrives
      out(id, ">>> if password:")
      cursorLine(term, ">>> if password:")
      await vi.advanceTimersByTimeAsync(1300)
      expect(st().remotePhase[id]).toBe("live")
      term.type("\r") // Enter: the next question may be a real prompt again…
      term.buffer.active.type = "alternate" // …but not inside vim
      out(id, "  password:")
      cursorLine(term, "  password:")
      await vi.advanceTimersByTimeAsync(1300)
      expect(st().remotePhase[id]).toBe("live")
      term.buffer.active.type = "normal"
      out(id, "[sudo] password for quang: ")
      cursorLine(term, "[sudo] password for quang: ")
      await vi.advanceTimersByTimeAsync(1300)
      expect(st().remoteDetail[id]).toBe("password")
    } finally {
      vi.useRealTimers()
    }
  })

  it("a prompt soft-wrapped in a narrow pane is still recognised", async () => {
    vi.useFakeTimers()
    try {
      const { id, term } = start({})
      await vi.advanceTimersByTimeAsync(0)
      out(id, "…")
      const rows = ["Are you sure you want to continue connec", "ting (yes/no/[fingerprint])? "]
      term.buffer.active.baseY = 0
      term.buffer.active.cursorY = 1
      term.buffer.active.getLine = ((y: number) =>
        rows[y] === undefined
          ? undefined
          : { translateToString: () => rows[y]!, isWrapped: y === 1 }) as never
      await vi.advanceTimersByTimeAsync(1300)
      expect(st().remoteDetail[id]).toBe("host key")
    } finally {
      vi.useRealTimers()
    }
  })

  it("a failure that can never work here: no retry by Enter or by Connect", async () => {
    vi.mocked(ipc.ptySpawn).mockRejectedValueOnce(new Error(SSH_ERRORS.newerBuild))
    const { id, term } = start({})
    await flush()
    expect(st().remotePhase[id]).toBe("failed")
    expect(st().remoteDetail[id]).toBe("not-here")
    term.type("\r")
    TerminalManager.connect(id)
    expect(spawnCalls()).toHaveLength(1)
    expect(term.written).toContain("Esc twice to close")
    expect(term.written).not.toContain("Enter to retry")
  })

  it("a host gone from the config records why (the header offers Open ssh config); Enter retries", async () => {
    vi.mocked(ipc.ptySpawn).mockRejectedValueOnce(new Error(SSH_ERRORS.hostGone))
    const { id, term } = start({})
    await flush()
    expect(st().remoteDetail[id]).toBe("host-gone")
    term.type("\r")
    expect(spawnCalls()).toHaveLength(2)
    expect(st().remotePhase[id]).toBe("starting")
    expect(st().remoteDetail[id]).toBeUndefined()
  })
})
