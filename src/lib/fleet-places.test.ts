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

  it("a failed lookup isn't an answer: the slot keeps what it had", () => {
    const ev = start("s1", "/w/r")
    const a = nextPlaces({}, at(ev, { root: "/w/r", branch: "main", forCwd: "/w/r" }))
    expect(nextPlaces(a, at(ev, { real: "/w/r", forCwd: "/w/r" }))).toBe(a)
  })

  it("back in the shell's folder, its own folder's slot empties (that lookup is dropped)", () => {
    const ev: AgentEvent[] = [
      ...start("s1", "/w/r"),
      { event: "CwdChanged", sessionId: "s1", cwd: "/w/r-b" },
    ]
    const away = {
      ...at(ev, { root: "/w/r", branch: "main", forCwd: "/w/r" }),
      paneGit: {
        p1: { root: "/w/r", branch: "main", forCwd: "/w/r" },
        "p1@in": { root: "/w/r-b", branch: "b", forCwd: "/w/r-b" },
      },
    }
    const a = nextPlaces({}, away)
    expect(a.s1!.in).toEqual({ root: "/w/r-b", branch: "b" })
    const back: AgentEvent[] = [...ev, { event: "CwdChanged", sessionId: "s1", cwd: "/w/r" }]
    const b = nextPlaces(a, at(back, { root: "/w/r", branch: "main", forCwd: "/w/r" }))
    expect(b.s1!.in).toBeUndefined()
  })

  it("its own folder waits for the shell's answer for the shell's folder", () => {
    const ev: AgentEvent[] = [
      ...start("s1", "/w/r"),
      { event: "CwdChanged", sessionId: "s1", cwd: "/w/r-a" },
    ]
    const inp = (shell: PaneGitInfo) => ({
      ...at(ev, shell, "/w/r-a"),
      paneGit: { p1: shell, "p1@in": { root: "/w/r-a", branch: "a", forCwd: "/w/r-a" } },
    })
    // the shell cd'd to /w/r-a, its answer still for /w/r-b: nothing decided yet
    expect(nextPlaces({}, inp({ root: "/w/r-b", forCwd: "/w/r-b" })).s1).toEqual({})
  })
})
