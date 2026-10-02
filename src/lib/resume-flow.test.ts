import { describe, it, expect } from "vitest"
import {
  canType,
  isSuspendCode,
  newShellFlow,
  onMark,
  parseMark,
  type ShellFlow,
} from "./resume-flow"

const C = { kind: "C" } as const
const D = (code?: number) => ({ kind: "D", code }) as const
const live = (o: Partial<ShellFlow> = {}): ShellFlow => ({
  ...newShellFlow(),
  replaying: false,
  ...o,
})

/** Run a sequence of marks; collect every action. */
function run(
  s: ShellFlow,
  marks: ({ kind: "C" } | { kind: "D"; code?: number })[],
  resuming = false,
) {
  const actions: string[] = []
  for (const m of marks) {
    const r = onMark(s, m, resuming)
    s = r.next
    actions.push(
      ...r.actions.map((a) => (a.type === "fail-resume" ? `fail:${a.exitCode}` : a.type)),
    )
  }
  return { s, actions }
}

describe("parseMark / isSuspendCode", () => {
  it("parses C and D;<code>; ignores other kinds", () => {
    expect(parseMark("C")).toEqual({ kind: "C" })
    expect(parseMark("D;130")).toEqual({ kind: "D", code: 130 })
    expect(parseMark("D")).toEqual({ kind: "D", code: undefined })
    expect(parseMark("A")).toBeNull()
  })
  it("146 / 148 are a Ctrl-Z suspend", () => {
    expect(isSuspendCode(146)).toBe(true)
    expect(isSuspendCode(148)).toBe(true)
    expect(isSuspendCode(0)).toBe(false)
  })
})

describe("onMark — shell idle (Claude exited)", () => {
  it("a prompt after a command where Claude ran → shell-idle, once", () => {
    const { actions, s } = run(live({ agentSeen: true }), [C, D(0)])
    expect(actions).toEqual(["shell-idle"])
    expect(s.agentSeen).toBe(false)
    expect(run(s, [C, D(0)]).actions).toEqual([]) // no Claude since → nothing to report
  })
  it("never for panes where Claude didn't run (no IPC per command)", () => {
    expect(run(live(), [C, D(0), C, D(1)]).actions).toEqual([])
  })
  it("never for replayed marks (a reattach replays old history)", () => {
    expect(run(live({ agentSeen: true, replaying: true }), [C, D(0)]).actions).toEqual([])
  })
  it("a Ctrl-Z'd job masks later prompts (the suspended Claude is alive)", () => {
    const { actions } = run(live({ agentSeen: true }), [C, D(148), C, D(0)])
    expect(actions).toEqual([])
  })
  it("a D without a preceding C (first prompt) isn't an exit", () => {
    expect(run(live({ agentSeen: true }), [D(0)]).actions).toEqual([])
  })
})

describe("onMark — resume flow", () => {
  it("the first prompt types the pending resume", () => {
    expect(run(live({ resumeStage: "await-prompt" }), [D(0)]).actions).toEqual(["type-resume"])
  })
  it("after typing: our command's C then D before confirmation → failed with the exit code", () => {
    const s = live({ resumeStage: "typed" })
    expect(run(s, [C, D(1)], true).actions).toEqual(["fail:1"])
  })
  it("slow rc: a late first-prompt D (no C yet) after typing is NOT a failure", () => {
    const s = live({ resumeStage: "typed" })
    expect(run(s, [D(0)], true).actions).toEqual([])
  })
  it("no failure once confirmed (not resuming) or when Claude was only suspended", () => {
    expect(run(live({ resumeStage: "typed" }), [C, D(1)], false).actions).toEqual([])
    expect(run(live({ resumeStage: "typed" }), [C, D(148)], true).actions).toEqual([])
  })
})

describe("canType", () => {
  it("never while the spawn hasn't said whether integration is there", () => {
    expect(canType(live({ integrated: undefined }))).toBe(false)
  })
  it("integrated: only after a prompt, and not while a program runs", () => {
    expect(canType(live({ integrated: true }))).toBe(false) // rc may still be running
    expect(canType(live({ integrated: true, seenPrompt: true }))).toBe(true)
    expect(canType(live({ integrated: true, seenPrompt: true, cmdRunning: true }))).toBe(false)
  })
  it("no integration: we can't tell → allowed", () => {
    expect(canType(live({ integrated: false }))).toBe(true)
  })
})
