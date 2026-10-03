import { describe, it, expect, beforeEach } from "vitest"
import { AgentLiveness, foldLiveness, LATE_MS } from "./agent-liveness"
import { SessionLedger } from "./agent-sessions"
import { claudeSessionRules } from "./agents/claude"
import { opencodeSessionRules } from "./agents/opencode"
import type { AgentEvent } from "../src/lib/agent-graph"

const live = new Set<number>()
let clock = 0
let checks = 0
const make = (platform = "darwin") =>
  new AgentLiveness(
    (k) => k !== "claude",
    (pid) => (checks++, live.has(pid)),
    () => clock,
    platform,
  )
const oc = (sessionId: string, pid: number, o: Partial<AgentEvent> = {}): AgentEvent => ({
  agent: "opencode",
  event: "PreToolUse",
  sessionId,
  paneId: "p1",
  pid,
  ...o,
})
const start = (sessionId: string, pid: number, o: Partial<AgentEvent> = {}) =>
  oc(sessionId, pid, { event: "SessionStart", cwd: "/repo", ...o })

beforeEach(() => {
  live.clear()
  live.add(100)
  live.add(200)
  clock = 1_000_000
  checks = 0
})

describe("AgentLiveness", () => {
  it("ends every session a dead process ran, with what locates its meta", () => {
    const l = make()
    l.observe(start("ses_a", 100, { transcriptPath: "/t/a" }))
    l.observe(start("ses_b", 100)) // /new
    l.observe(start("ses_x", 200)) // another process: still alive
    expect(l.reap()).toEqual([])
    live.delete(100)
    expect(l.reap()).toEqual([
      {
        agent: "opencode",
        event: "SessionEnd",
        sessionId: "ses_a",
        paneId: "p1",
        pid: 100,
        cwd: "/repo",
        transcriptPath: "/t/a",
        reason: "exited",
      },
      expect.objectContaining({ event: "SessionEnd", sessionId: "ses_b", pid: 100 }),
    ])
    expect(l.reap()).toEqual([]) // once
    expect(l.hasProcs()).toBe(true) // 200
  })

  it("one burst, then gone (a prompt that failed at once): still ended", () => {
    const l = make()
    l.observe(start("ses_q", 300))
    l.observe(oc("ses_q", 300, { event: "Stop" }))
    expect(l.reap().map((e) => e.sessionId)).toEqual(["ses_q"])
  })

  it("a SessionEnd forgets the session; the last one forgets the process", () => {
    const l = make()
    l.observe(start("ses_a", 100))
    l.observe(oc("ses_a", 100, { event: "SessionEnd" }))
    expect(l.hasProcs()).toBe(false)
    live.delete(100)
    expect(l.reap()).toEqual([])
  })

  it("a reaped process's late drops don't count; a new process reusing the pid does", () => {
    const l = make()
    l.observe(start("ses_a", 100))
    live.delete(100)
    l.reap()
    expect(l.isLate(oc("ses_a", 100, { event: "Stop" }))).toBe(true)
    // /new right before the quit: its start is in flight, and the pid is still dead.
    expect(l.isLate(start("ses_new", 100))).toBe(true)
    live.add(100) // a new process got the pid: its sessions count
    expect(l.isLate(start("ses_new", 100))).toBe(false)
    expect(l.isLate(oc("ses_a", 100, { event: "Stop" }))).toBe(true) // not the old session's
    clock += LATE_MS + 1
    l.reap() // forgets old reaps
    expect(l.isLate(oc("ses_a", 100, { event: "Stop" }))).toBe(false)
  })

  it("only by-pid agents (not Claude's hook shells), only root events, never on Windows", () => {
    const l = make()
    l.observe({ ...start("ses_c", 400), agent: "claude" })
    l.observe(oc("ses_a", 400, { agentId: "ses_child" }))
    expect(l.hasProcs()).toBe(false)
    const win = make("win32")
    win.observe(start("ses_a", 100))
    expect(win.hasProcs()).toBe(false)
  })
})

describe("foldLiveness", () => {
  it("a session starting where a dead one led comes after its end; late drops are left out", () => {
    const l = make()
    l.observe(start("ses_a", 100))
    live.delete(100) // OpenCode quit silently (fish), and its last drop is still in flight
    const late = oc("ses_a", 100, { event: "Stop" })
    const next = start("ses_b", 200)
    const out = foldLiveness([late, next], l)
    // Its last drop folds before its end (it's no longer late: it was read before the reap).
    expect(out.map((e) => `${e.event} ${e.sessionId}`)).toEqual([
      "Stop ses_a",
      "SessionEnd ses_a",
      "SessionStart ses_b",
    ])
    // The ledger then lets the new one lead instead of nesting it in a dead session.
    const ledger = new SessionLedger(null, Date.now, {
      claude: claudeSessionRules,
      opencode: opencodeSessionRules,
    })
    ledger.apply(start("ses_a", 100))
    for (const e of out) ledger.apply(e)
    expect(ledger.get("p1")?.sessionId).toBe("ses_b")
    expect(ledger.isNested("p1", "ses_b")).toBe(false)
  })

  it("a dead process's start in the same batch as a new one's: it ends before the new start", () => {
    const l = make()
    live.delete(100) // an `opencode run` that failed at once: start written, process gone
    const out = foldLiveness([start("ses_a", 100), start("ses_b", 200)], l)
    expect(out.map((e) => `${e.event} ${e.sessionId}`)).toEqual([
      "SessionStart ses_a",
      "SessionEnd ses_a",
      "SessionStart ses_b",
    ])
  })

  it("never drops a Claude event, even from a pid just reaped (hook shells reuse pids)", () => {
    const l = make()
    l.observe(start("ses_a", 100))
    live.delete(100)
    l.reap()
    expect(l.isLate({ ...start("ses_c", 100), agent: "claude" })).toBe(false)
  })

  it("no start, or only Claude: the batch as it is, and no process check", () => {
    const batch = [oc("ses_a", 100)]
    expect(foldLiveness(batch, make())).toEqual(batch) // no SessionStart: no reap
    const claude = [{ ...start("ses_c", 300), agent: "claude" as const }]
    expect(foldLiveness(claude, make())).toEqual(claude) // nothing tracked: no reap
    expect(checks).toBe(0)
  })
})
