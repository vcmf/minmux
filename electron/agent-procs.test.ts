import { spawn } from "node:child_process"
import { afterEach, describe, expect, it } from "vitest"
import { AgentProcs, endProcs, parseProcs, posixProcs, sleep } from "./agent-procs"

describe("AgentProcs", () => {
  it("lists each pane's agent processes, once each", () => {
    const procs = new AgentProcs(() => true)
    procs.note("a", 10)
    procs.note("a", 10)
    procs.note("a", 11)
    procs.note("b", 20)
    expect(procs.pidsOf("a")).toEqual([10, 11])
    expect(procs.pidsOf("b")).toEqual([20])
    expect(procs.pidsOf("c")).toEqual([])
  })

  it("drops the ended ones when a new one comes (their pids may be reused)", () => {
    const live = new Set([10, 11, 12])
    const procs = new AgentProcs((p) => live.has(p))
    procs.note("a", 10)
    procs.note("a", 11)
    live.delete(10)
    procs.note("a", 12)
    expect(procs.pidsOf("a")).toEqual([11, 12])
  })

  it("never lists a process already gone (a drop read late: its pid may be reused)", () => {
    const procs = new AgentProcs((p) => p !== 13)
    procs.note("a", 13)
    expect(procs.pidsOf("a")).toEqual([])
  })

  it("stays bounded, and forgets a closed pane", () => {
    const procs = new AgentProcs(() => true)
    for (let p = 100; p < 120; p++) procs.note("a", p)
    expect(procs.pidsOf("a")).toHaveLength(8)
    expect(procs.pidsOf("a").at(-1)).toBe(119)
    procs.forget("a")
    expect(procs.pidsOf("a")).toEqual([])
  })
})

describe("parseProcs", () => {
  it("maps each pid to its terminal (macOS and Linux names) and its place on it", () => {
    expect(parseProcs("  100   100   100 ttys004\n  200   150   300 pts/3\n")).toEqual(
      new Map([
        [100, { tty: "/dev/ttys004", foreground: 100 }],
        [200, { tty: "/dev/pts/3" }], // a background job's
      ]),
    )
  })
  it("in the foreground behind a wrapper: not its group's leader", () => {
    expect(parseProcs("201 150 150 ttys004")).toEqual(
      new Map([[201, { tty: "/dev/ttys004", foreground: 150 }]]),
    )
  })
  it("skips one without a terminal, and anything unreadable", () => {
    expect(parseProcs("100 100 -1 ??\n200 200 0 ?\n\nnope\n")).toEqual(new Map())
  })
})

/** Start `sh -c script` and resolve once it printed "ready" (its trap is installed) — not after
 *  a guessed delay, which a busy machine outruns. */
const spawnReady = (script: string, detached = false) => {
  const child = spawn("sh", ["-c", script], { detached, stdio: ["ignore", "pipe", "ignore"] })
  const ready = new Promise<void>((resolve) => {
    let out = ""
    child.stdout!.on("data", (d: Buffer) => {
      out += d.toString()
      if (out.includes("ready")) resolve()
    })
  })
  return { child, ready }
}

describe.skipIf(process.platform === "win32")("posixProcs + endProcs (real processes)", () => {
  const spawned: number[] = []
  afterEach(() => {
    for (const p of spawned.splice(0)) posixProcs.kill(p, p) // never leak a loop (each its own group)
  })

  it("SIGKILLs an agent that ignores HUP, TERM and INT", async () => {
    const { child, ready } = spawnReady(
      'trap "" HUP TERM INT; echo ready; while :; do sleep 0.05; done',
    )
    const pid = child.pid!
    spawned.push(pid)
    const gone = new Promise((r) => child.on("exit", (_c, sig) => r(sig)))
    await ready // the trap is installed
    for (const sig of ["SIGHUP", "SIGTERM", "SIGINT"] as const) process.kill(pid, sig)
    expect(posixProcs.alive(pid)).toBe(true)
    expect(await endProcs([{ pid }], posixProcs, { graceMs: 150 })).toEqual([pid])
    expect(await gone).toBe("SIGKILL")
    expect(await endProcs([{ pid }], posixProcs)).toEqual([]) // ended: nothing left
  })

  it("leaves one that ends within the grace", async () => {
    const child = spawn("sh", ["-c", "sleep 0.1"], { stdio: "ignore" })
    spawned.push(child.pid!)
    const exited = new Promise((r) => child.on("exit", r))
    expect(await endProcs([{ pid: child.pid! }], posixProcs, { graceMs: 1000 })).toEqual([])
    await exited
  })

  it("SIGKILLs a stuck agent with its foreground job (what it started goes too)", async () => {
    const { child, ready } = spawnReady(
      'trap "" HUP TERM INT; sleep 30 & echo ready; while :; do sleep 0.05; done',
      true, // a job of its own, as a shell starts one
    )
    const pid = child.pid!
    spawned.push(pid)
    await ready
    expect(await endProcs([{ pid, pgid: pid }], posixProcs, { graceMs: 50 })).toEqual([pid])
    await new Promise((r) => child.on("exit", r))
    // Its `sleep 30` went with it — the OS reaps a killed group asynchronously (slower when
    // busy): poll for it to be gone rather than guessing a delay.
    const alive = () => {
      try {
        process.kill(-pid, 0)
        return true
      } catch {
        return false
      }
    }
    for (let i = 0; i < 300 && alive(); i++) await sleep(10)
    expect(() => process.kill(-pid, 0)).toThrow()
  })

  it("a ps that fails outright rejects (reported, never read as no agents)", async () => {
    await expect(posixProcs.info([-5])).rejects.toThrow()
  })

  it("asks ps without failing on pids that are gone or have no terminal", async () => {
    expect(await posixProcs.info([])).toEqual(new Map())
    const gone = spawn("true")
    await new Promise((r) => gone.on("exit", r))
    expect(await posixProcs.info([gone.pid!])).toEqual(new Map()) // ps exits 1, silently
    expect(await posixProcs.info([process.pid])).toBeInstanceOf(Map) // a terminal or none
  })
})
