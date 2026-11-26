import { describe, it, expect } from "vitest"
import { nextPlaces, type PlacesInput } from "./fleet-places"
import { reduceAgentEvents, type AgentEvent } from "./agent-graph"
import type { PaneGitInfo } from "./pane-git"

const start = (sessionId: string, cwd: string): AgentEvent[] => [
  { event: "SessionStart", sessionId, cwd, paneId: "p1" },
  { event: "UserPromptSubmit", sessionId },
]
const at = (events: AgentEvent[], shell: PaneGitInfo, cwd = "/w/r"): PlacesInput => ({
  agents: reduceAgentEvents(events),
  paneGit: { p1: shell },
  sessions: { p1: { cwd } },
  paneWork: {},
})

describe("nextPlaces", () => {
  it("a slot changes on an answer for its folder; else keeps what it had", () => {
    const ev = start("s1", "/w/r")
    const a = nextPlaces({}, at(ev, { root: "/w/r", branch: "main", forCwd: "/w/r" }))
    expect(a.s1).toEqual({ from: { root: "/w/r", branch: "main" } })
    // the same answer again: the same ledger
    expect(nextPlaces(a, at(ev, { root: "/w/r", branch: "main", forCwd: "/w/r" }))).toBe(a)
    // `cd` elsewhere, its answer on the way: kept
    const b = nextPlaces(a, at(ev, { root: "/w/r", branch: "main", forCwd: "/w/r" }, "/w/x"))
    expect(b).toBe(a)
    // answered there: not a repo, the slot empties
    const c = nextPlaces(b, at(ev, { noRepo: true, forCwd: "/w/x" }, "/w/x"))
    expect(c.s1).toEqual({})
  })

  it("an ended session leaves the ledger", () => {
    const ev = start("s1", "/w/r")
    const a = nextPlaces({}, at(ev, { root: "/w/r", forCwd: "/w/r" }))
    const gone = nextPlaces(a, {
      ...at(ev, { root: "/w/r", forCwd: "/w/r" }),
      sessions: {},
    })
    expect(gone).toEqual({})
  })
})
