import { describe, expect, it } from "vitest"
import type { AgentGraph, AgentNode } from "./agent-graph"
import type { ResumePlan } from "./resume"
import {
  ago,
  filterPast,
  isTypedPrompt,
  mergePast,
  oneLine,
  paneOf,
  pastLabel,
  type PastSession,
} from "./past-sessions"

const row = (o: Partial<PastSession>): PastSession => ({
  agent: "claude",
  sessionId: "s1",
  updatedAt: 1,
  ...o,
})

describe("labels", () => {
  it("puts text on one capped line", () => {
    expect(oneLine("  fix\n the   quit\tdrain ")).toBe("fix the quit drain")
    expect(oneLine("x".repeat(300))).toHaveLength(200)
    expect(oneLine("x".repeat(300))!.endsWith("…")).toBe(true)
    expect(oneLine(" \n ")).toBeUndefined()
  })

  it("names a row by its name, else its first prompt", () => {
    expect(pastLabel(row({ name: "quit drain", firstPrompt: "fix it" }))).toBe("quit drain")
    expect(pastLabel(row({ firstPrompt: "fix it" }))).toBe("fix it")
    expect(pastLabel(row({}))).toBe("Untitled session")
  })

  it("only counts what the user typed as a prompt, not the agent's own blocks", () => {
    const injected = /^(<command-|Caveat: )/
    expect(isTypedPrompt("fix the quit drain", injected)).toBe(true)
    expect(isTypedPrompt("<command-name>/clear</command-name>", injected)).toBe(false)
    expect(isTypedPrompt("  Caveat: generated", injected)).toBe(false)
    expect(isTypedPrompt("  ", injected)).toBe(false)
  })
})

describe("mergePast", () => {
  it("puts the newest first, one row per session, at most `max`", () => {
    const merged = mergePast(
      [
        [row({ sessionId: "a", updatedAt: 1 }), row({ sessionId: "b", updatedAt: 5 })],
        [row({ agent: "codex", sessionId: "a", updatedAt: 3 })], // another agent's: its own row
        [row({ sessionId: "a", updatedAt: 9, name: "newer copy" })],
      ],
      3,
    )
    expect(merged.map((s) => `${s.agent}:${s.sessionId}:${s.updatedAt}`)).toEqual([
      "claude:a:9",
      "claude:b:5",
      "codex:a:3",
    ])
    expect(mergePast([merged], 2)).toHaveLength(2)
  })
})

describe("filterPast", () => {
  const list = [
    row({ sessionId: "1", cwd: "/w/term" }),
    row({ sessionId: "2", cwd: "/w/term/landing" }),
    row({ sessionId: "3", cwd: "/w/termite" }),
    row({ sessionId: "4", agent: "codex", cwd: "/w/term" }),
    row({ sessionId: "5" }), // folder unknown
  ]
  const ids = (l: PastSession[]) => l.map((s) => s.sessionId)

  it("keeps the chosen agents", () => {
    expect(ids(filterPast(list, new Set(["codex"])))).toEqual(["4"])
  })

  it("here: that folder and below, never a sibling with the same prefix", () => {
    expect(ids(filterPast(list, new Set(["claude", "codex"]), "/w/term/"))).toEqual(["1", "2", "4"])
  })
})

describe("ago", () => {
  it("says how long ago, compactly", () => {
    const now = 1_000_000_000
    expect(ago(now - 10_000, now)).toBe("now")
    expect(ago(now - 5 * 60_000, now)).toBe("5m")
    expect(ago(now - 3 * 3600_000, now)).toBe("3h")
    expect(ago(now - 2 * 86400_000, now)).toBe("2d")
    expect(ago(now - 15 * 86400_000, now)).toBe("2w")
    expect(ago(now - 400 * 86400_000, now)).toBe("1y")
    expect(ago(now + 5000, now)).toBe("now") // a clock skew is never negative
  })
})

describe("paneOf", () => {
  const node = (o: Partial<AgentNode>) => ({ id: "root:s1", sessionId: "s1", ...o }) as AgentNode
  const graph = (n?: AgentNode): AgentGraph => ({
    nodes: n ? { [n.id]: n } : {},
    rootIds: n ? [n.id] : [],
  })
  const plan: ResumePlan = { status: "resume", sessionId: "s1", cwd: "/w" }
  const s = { agent: "claude" as const, sessionId: "s1" }

  it("is the terminal the session runs in", () => {
    expect(paneOf(s, graph(node({ agent: "claude", paneId: "t1" })), { t1: {} }, {})).toBe("t1")
  })

  it("not when that terminal is gone, or it's another agent's session", () => {
    expect(paneOf(s, graph(node({ agent: "claude", paneId: "t1" })), {}, {})).toBeUndefined()
    expect(paneOf(s, graph(node({ agent: "codex", paneId: "t1" })), { t1: {} }, {})).toBeUndefined()
  })

  it("is the terminal resuming it, until that resume fails", () => {
    expect(paneOf(s, graph(), { t2: {} }, { t2: { phase: "pending", plan } })).toBe("t2")
    expect(paneOf(s, graph(), { t2: {} }, { t2: { phase: "resuming", plan } })).toBe("t2")
    expect(paneOf(s, graph(), { t2: {} }, { t2: { phase: "failed", plan } })).toBeUndefined()
    // typed into a shell that can't confirm it: that terminal has it
    expect(paneOf(s, graph(), { t2: {} }, { t2: { phase: "sent", plan } })).toBe("t2")
  })
})
