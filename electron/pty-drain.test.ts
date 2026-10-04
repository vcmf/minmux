import { describe, it, expect, vi, afterEach } from "vitest"
import { drainPtys, type Drainable } from "./pty-drain"
import type { ProcInfo, Procs } from "./agent-procs"

// A fake PTY: exits `afterMs` after the signal it responds to (null = ignores it).
function fakePty(onHup: number | null, onKill: number | null = 0) {
  let exit!: () => void
  const exited = new Promise<void>((r) => (exit = r))
  const signals: string[] = []
  const p: Drainable & { signals: string[] } = {
    signals,
    exited,
    kill: (sig = "SIGHUP") => {
      signals.push(sig)
      const ms = sig === "SIGKILL" ? onKill : onHup
      if (ms !== null) setTimeout(exit, ms)
    },
  }
  return p
}

describe("drainPtys", () => {
  afterEach(() => vi.useRealTimers())

  it("hangs up every PTY and resolves once all have exited", async () => {
    vi.useFakeTimers()
    const a = fakePty(10)
    const b = fakePty(50)
    const done = drainPtys([a, b])
    await vi.advanceTimersByTimeAsync(60)
    expect(await done).toBe(true)
    expect(a.signals).toEqual(["SIGHUP"])
    expect(b.signals).toEqual(["SIGHUP"])
  })

  it("SIGKILLs a PTY that ignores the hang-up, after the grace period", async () => {
    vi.useFakeTimers()
    const stubborn = fakePty(null, 5)
    const done = drainPtys([stubborn], { graceMs: 100, forceMs: 50 })
    await vi.advanceTimersByTimeAsync(99)
    expect(stubborn.signals).toEqual(["SIGHUP"])
    await vi.advanceTimersByTimeAsync(10)
    expect(stubborn.signals).toEqual(["SIGHUP", "SIGKILL"])
    await vi.advanceTimersByTimeAsync(10)
    expect(await done).toBe(true)
  })

  it("never blocks the quit: resolves false when even SIGKILL doesn't end it", async () => {
    vi.useFakeTimers()
    const zombie = fakePty(null, null)
    const done = drainPtys([zombie], { graceMs: 100, forceMs: 50 })
    await vi.advanceTimersByTimeAsync(200)
    expect(await done).toBe(false)
  })

  it("a failed kill still waits for that PTY's exit (its callback may be pending)", async () => {
    vi.useFakeTimers()
    let exit!: () => void
    const halfClosed: Drainable = {
      exited: new Promise((r) => (exit = r)),
      kill: () => {
        throw new Error("handle closed")
      },
    }
    let done = false
    void drainPtys([halfClosed], { graceMs: 100 }).then(() => (done = true))
    await vi.advanceTimersByTimeAsync(20)
    expect(done).toBe(false) // still waiting on it
    exit()
    await vi.advanceTimersByTimeAsync(0)
    expect(done).toBe(true)
  })

  it("Windows: no signals (a queued SIGKILL would throw later), then a settle wait", async () => {
    vi.useFakeTimers()
    const p = fakePty(null)
    let result: boolean | undefined
    void drainPtys([p], { graceMs: 100, signals: false, settleMs: 300 }).then((r) => (result = r))
    await vi.advanceTimersByTimeAsync(150)
    expect(p.signals).toEqual(["SIGHUP"]) // never SIGKILL
    expect(result).toBeUndefined() // settling
    await vi.advanceTimersByTimeAsync(300)
    expect(result).toBe(false)
  })

  it("a PTY already hung up (closed pane) is waited for, not signalled again", async () => {
    vi.useFakeTimers()
    const signals: string[] = []
    let exit!: () => void
    const closing: Drainable = {
      killed: true,
      exited: new Promise((r) => (exit = r)),
      kill: (sig = "SIGHUP") => void signals.push(sig),
    }
    setTimeout(() => exit(), 30) // its own shutdown finishes
    let done = false
    void drainPtys([closing], { graceMs: 100 }).then(() => (done = true))
    await vi.advanceTimersByTimeAsync(10)
    expect(done).toBe(false)
    await vi.advanceTimersByTimeAsync(30)
    expect(done).toBe(true)
    expect(signals).toEqual([])
  })

  it("nothing to drain → resolves immediately", async () => {
    expect(await drainPtys([])).toBe(true)
  })
})

// Fake agent processes: where each runs (`fg: false` = a background job), and when it ends
// after its terminal's hang-up (null = ignores it, like a stuck OpenCode).
type At = { tty: string; fg?: boolean }
function fakeProcs(where: Record<number, At>, ends: Record<number, number | null>) {
  const running = new Set(Object.keys(where).map(Number))
  const killed: number[] = []
  const procs: Procs = {
    info: vi.fn(async (pids: number[]) => {
      const out = new Map<number, ProcInfo>()
      for (const p of pids)
        if (running.has(p))
          out.set(p, { tty: where[p]!.tty, ...((where[p]!.fg ?? true) ? { foreground: p } : {}) })
      return out
    }),
    alive: (p) => running.has(p),
    kill: (p) => {
      killed.push(p)
      running.delete(p)
    },
  }
  const hangUp = () => {
    for (const p of running) if (ends[p] != null) setTimeout(() => running.delete(p), ends[p]!)
  }
  return { procs, killed, hangUp }
}

// A terminal whose hang-up also reaches the agents in it (as the kernel does).
function terminal(tty: string, agents: number[], hangUp: () => void, exitMs = 5) {
  const p: ReturnType<typeof fakePty> = { ...fakePty(exitMs), tty, agentPids: () => agents }
  const kill = p.kill
  p.kill = (sig) => {
    if (!sig) hangUp()
    kill(sig)
  }
  return p
}

describe("drainPtys: the agents running in the terminals", () => {
  afterEach(() => vi.useRealTimers())

  it("SIGKILLs an agent that ignores the hang-up, even though its shell exited cleanly", async () => {
    vi.useFakeTimers()
    const { procs, killed, hangUp } = fakeProcs({ 11: { tty: "/dev/ttys001" } }, { 11: null })
    const onAgentsKilled = vi.fn()
    const pty = terminal("/dev/ttys001", [11], hangUp)
    const done = drainPtys([pty], { graceMs: 100, procs, onAgentsKilled })
    await vi.advanceTimersByTimeAsync(90)
    expect(killed).toEqual([]) // still within the grace
    await vi.advanceTimersByTimeAsync(100)
    expect(await done).toBe(true) // the shell's own drain was clean
    expect(killed).toEqual([11])
    expect(onAgentsKilled).toHaveBeenCalledWith([11])
  })

  it("leaves alone an agent that ends with its terminal", async () => {
    vi.useFakeTimers()
    const { procs, killed, hangUp } = fakeProcs(
      { 11: { tty: "/dev/ttys001" }, 21: { tty: "/dev/ttys002" } },
      { 11: 20, 21: 60 },
    )
    const ptys = [terminal("/dev/ttys001", [11], hangUp), terminal("/dev/ttys002", [21], hangUp)]
    const done = drainPtys(ptys, { graceMs: 100, procs })
    await vi.advanceTimersByTimeAsync(200)
    expect(await done).toBe(true)
    expect(killed).toEqual([])
  })

  it("never kills a pid that isn't on that terminal any more (reused by something else)", async () => {
    vi.useFakeTimers()
    const { procs, killed, hangUp } = fakeProcs({ 11: { tty: "/dev/ttys009" } }, { 11: null })
    const done = drainPtys([terminal("/dev/ttys001", [11], hangUp)], { graceMs: 50, procs })
    await vi.advanceTimersByTimeAsync(200)
    expect(await done).toBe(true)
    expect(killed).toEqual([])
  })

  it("leaves alone an agent the user sent to the background (`nohup … &`)", async () => {
    vi.useFakeTimers()
    const { procs, killed, hangUp } = fakeProcs(
      { 11: { tty: "/dev/ttys001", fg: false } },
      { 11: null },
    )
    const done = drainPtys([terminal("/dev/ttys001", [11], hangUp)], { graceMs: 50, procs })
    await vi.advanceTimersByTimeAsync(200)
    expect(await done).toBe(true)
    expect(killed).toEqual([])
  })

  it("asks once, and only about the agents of terminals it hangs up", async () => {
    vi.useFakeTimers()
    const { procs, hangUp } = fakeProcs(
      { 11: { tty: "/dev/ttys001" }, 12: { tty: "/dev/ttys001" }, 21: { tty: "/dev/ttys002" } },
      { 11: 1, 12: 1, 21: 1 },
    )
    const closing = { ...terminal("/dev/ttys002", [21], hangUp), killed: true }
    setTimeout(() => closing.kill(), 1)
    const ptys = [
      terminal("/dev/ttys001", [11, 12], hangUp),
      closing,
      terminal("/dev/ttys003", [], hangUp),
      fakePty(5), // no tty (Windows)
    ]
    const done = drainPtys(ptys, { procs })
    await vi.advanceTimersByTimeAsync(50)
    expect(await done).toBe(true)
    expect(vi.mocked(procs.info).mock.calls).toEqual([[[11, 12]]])
  })

  it("hangs up the terminals without agents at once, without waiting for ps", async () => {
    vi.useFakeTimers()
    const { procs, hangUp } = fakeProcs({ 11: { tty: "/dev/ttys001" } }, { 11: 1 })
    let answer!: (m: Map<number, ProcInfo>) => void
    procs.info = () => new Promise((r) => (answer = r))
    const plain = terminal("/dev/ttys002", [], hangUp)
    const agent = terminal("/dev/ttys001", [11], hangUp)
    const done = drainPtys([plain, agent], { procs })
    await vi.advanceTimersByTimeAsync(0)
    expect(plain.signals).toEqual(["SIGHUP"])
    expect(agent.signals).toEqual([]) // asked about first
    answer(new Map())
    await vi.advanceTimersByTimeAsync(20)
    expect(agent.signals).toEqual(["SIGHUP"])
    expect(await done).toBe(true)
  })

  it("an agent that already ended: no ps (its pid may be reused)", async () => {
    vi.useFakeTimers()
    const { procs, hangUp } = fakeProcs({}, {})
    const done = drainPtys([terminal("/dev/ttys001", [11], hangUp)], { procs })
    await vi.advanceTimersByTimeAsync(50)
    expect(await done).toBe(true)
    expect(procs.info).not.toHaveBeenCalled()
  })

  it("no agent ran: no ps at all", async () => {
    vi.useFakeTimers()
    const { procs, hangUp } = fakeProcs({}, {})
    const done = drainPtys([terminal("/dev/ttys001", [], hangUp)], { procs })
    await vi.advanceTimersByTimeAsync(50)
    expect(await done).toBe(true)
    expect(procs.info).not.toHaveBeenCalled()
  })

  it("hangs up a PTY marked as closing right after the call (a pane close does)", async () => {
    vi.useFakeTimers()
    const { procs } = fakeProcs({}, {})
    const p = { ...fakePty(5), tty: "/dev/ttys001" }
    const done = drainPtys([p], { procs })
    p.killed = true // pty:kill marks it so a quit doesn't signal it again
    await vi.advanceTimersByTimeAsync(20)
    expect(await done).toBe(true)
    expect(p.signals).toEqual(["SIGHUP"])
  })

  it("still hangs up when asking fails, and a throwing callback doesn't fail the drain", async () => {
    vi.useFakeTimers()
    const broken = fakeProcs({ 11: { tty: "/dev/ttys001" } }, { 11: 1 })
    broken.procs.info = () => Promise.reject(new Error("EAGAIN"))
    const p = terminal("/dev/ttys001", [11], broken.hangUp)
    const onLookupFailed = vi.fn()
    const first = drainPtys([p], { procs: broken.procs, onLookupFailed })
    await vi.advanceTimersByTimeAsync(20)
    expect(await first).toBe(true)
    expect(p.signals).toEqual(["SIGHUP"])
    expect(onLookupFailed).toHaveBeenCalledWith(new Error("EAGAIN"))

    const { procs, hangUp } = fakeProcs({ 11: { tty: "/dev/ttys001" } }, { 11: null })
    const second = drainPtys([terminal("/dev/ttys001", [11], hangUp)], {
      graceMs: 50,
      procs,
      onAgentsKilled: () => {
        throw new Error("disk full")
      },
    })
    await vi.advanceTimersByTimeAsync(200)
    expect(await second).toBe(true)
  })
})
