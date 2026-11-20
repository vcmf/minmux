import { describe, expect, it } from "vitest"
import { activeGroups, ELSEWHERE, inactiveOf, pastIndex } from "./agents-list"
import { reduceAgentEvents, type AgentGraph, type AgentKind } from "./agent-graph"
import type { PastSession } from "./past-sessions"
import type { Tab } from "../types"

const tab = (id: string, ...panes: string[]): Tab => ({
  id,
  title: id,
  activeEntryId: panes[0]!,
  activeSessionId: panes[0]!,
  root:
    panes.length === 1
      ? { type: "leaf", id: `l-${id}`, entryIds: panes, activeEntryId: panes[0]! }
      : {
          type: "split",
          id: `s-${id}`,
          direction: "row",
          children: [
            { type: "leaf", id: `l1-${id}`, entryIds: [panes[0]!], activeEntryId: panes[0]! },
            { type: "leaf", id: `l2-${id}`, entryIds: [panes[1]!], activeEntryId: panes[1]! },
          ],
        },
})
const past = (sessionId: string, updatedAt: number, agent: AgentKind = "claude"): PastSession => ({
  agent,
  sessionId,
  updatedAt,
  cwd: "/w",
})
const all = () => true

/** Both pieces, as the panel composes them (`panes[i]` = the open pane of `past[i]`). */
function agentsList(o: {
  graph: AgentGraph
  tabs: Tab[]
  activeTabId: string
  past: PastSession[]
  panes: string[]
  shows: (agent: AgentKind, cwd?: string) => boolean
}) {
  const open = new Map<string, string>()
  o.past.forEach((s, i) => o.panes[i] && open.set(`${s.agent}:${s.sessionId}`, o.panes[i]))
  const { groups, keys } = activeGroups({ ...o, past: pastIndex(o.past), open })
  return { groups, inactive: inactiveOf(o.past, open, keys) }
}

describe("agentsList", () => {
  const tabs = [tab("t1", "p1", "p2"), tab("t2", "p3")]
  const graph = reduceAgentEvents([
    { event: "SessionStart", sessionId: "a", paneId: "p3", cwd: "/w" },
    { event: "SessionStart", sessionId: "b", paneId: "p1", cwd: "/w" },
    { event: "SessionStart", sessionId: "c", paneId: "p2", cwd: "/w" },
    { event: "SessionEnd", sessionId: "c", paneId: "p2" },
    { event: "SessionStart", sessionId: "x", cwd: "/w" }, // no pane: run outside minmux
  ])

  it("groups by tab, the current one first; running before ended; elsewhere last", () => {
    const { groups } = agentsList({
      graph,
      tabs,
      activeTabId: "t2",
      past: [],
      panes: [],
      shows: all,
    })
    expect(
      groups.map((g) => [
        g.id,
        g.current,
        g.rows.map((r) => `${r.sessionId}${r.running ? "" : "·ended"}`),
      ]),
    ).toEqual([
      ["t2", true, ["a"]],
      ["t1", false, ["b", "c·ended"]],
      [ELSEWHERE, false, ["x"]],
    ])
  })

  it("inactive: the past sessions in no open pane, newest first as listed; none twice", () => {
    const list = [past("c", 50), past("old", 40), past("older", 10)]
    const { groups, inactive } = agentsList({
      graph,
      tabs,
      activeTabId: "t1",
      past: list,
      panes: ["p2", "", ""],
      shows: all,
    })
    expect(inactive.map((s) => s.sessionId)).toEqual(["old", "older"])
    expect(groups[0]!.rows.find((r) => r.sessionId === "c")?.past?.updatedAt).toBe(50)
  })

  it("a resume on its way (open in a pane, not on the board yet) is active and running", () => {
    const { groups, inactive } = agentsList({
      graph: reduceAgentEvents([]),
      tabs,
      activeTabId: "t1",
      past: [past("r", 5)],
      panes: ["p1"],
      shows: all,
    })
    expect(groups[0]!.rows.map((r) => [r.sessionId, r.running, r.paneId])).toEqual([
      ["r", true, "p1"],
    ])
    expect(inactive).toEqual([])
  })

  it("the filters apply to both sections", () => {
    const { groups, inactive } = agentsList({
      graph,
      tabs,
      activeTabId: "t1",
      past: [past("o1", 9, "codex")], // the listing comes filtered (filterPast)
      panes: [""],
      shows: (agent) => agent === "codex",
    })
    expect(groups).toEqual([]) // the board's (claude) sessions: filtered here
    expect(inactive.map((s) => s.sessionId)).toEqual(["o1"])
  })

  it("a session ended in one pane and resuming in another: running in the new one", () => {
    const g = reduceAgentEvents([
      { event: "SessionStart", sessionId: "e", paneId: "p1", cwd: "/w" },
      { event: "SessionEnd", sessionId: "e", paneId: "p1" },
    ])
    const { groups } = agentsList({
      graph: g,
      tabs,
      activeTabId: "t1",
      past: [past("e", 5)],
      panes: ["p3"], // resumeInSplit opened it there; its SessionStart hasn't come yet
      shows: all,
    })
    expect(
      groups.flatMap((x) => x.rows.map((r) => `${r.sessionId}@${r.paneId}:${r.running}`)),
    ).toEqual(["e@p3:true"])
  })

  it("a running session whose pane closed: elsewhere, with no pane to go to", () => {
    const g = reduceAgentEvents([
      { event: "SessionStart", sessionId: "h", paneId: "closed", cwd: "/w" },
    ])
    const { groups } = agentsList({
      graph: g,
      tabs,
      activeTabId: "t1",
      past: [],
      panes: [],
      shows: all,
    })
    expect(groups.map((x) => [x.id, x.rows[0]!.paneId])).toEqual([[ELSEWHERE, ""]])
  })

  it("an ended session the board knows whose pane is gone is just a past session", () => {
    const g = reduceAgentEvents([
      { event: "SessionStart", sessionId: "gone", paneId: "closed", cwd: "/w" },
      { event: "SessionEnd", sessionId: "gone", paneId: "closed" },
    ])
    const { groups, inactive } = agentsList({
      graph: g,
      tabs,
      activeTabId: "t1",
      past: [past("gone", 3)],
      panes: [""],
      shows: all,
    })
    expect(groups).toEqual([])
    expect(inactive.map((s) => s.sessionId)).toEqual(["gone"])
  })
})

describe("activeGroups / inactiveOf: the pieces the panel memoises", () => {
  const tabs = [tab("t1", "p1")]
  it("the groups walk the board and the open panes, not the listing; inactive is the rest", () => {
    const g = reduceAgentEvents([
      { event: "SessionStart", sessionId: "a", paneId: "p1", cwd: "/w" },
    ])
    const list = [past("a", 3), past("r", 2), past("x", 1)]
    const open = new Map([["claude:r", "p1"]]) // r: a resume on its way in p1
    const { groups, keys } = activeGroups({
      graph: g,
      tabs,
      activeTabId: "t1",
      past: pastIndex(list),
      open,
      shows: all,
    })
    expect(groups[0]!.rows.map((r) => r.sessionId)).toEqual(["a", "r"])
    expect(inactiveOf(list, open, keys).map((s) => s.sessionId)).toEqual(["x"])
  })
})

describe("a filter leaves a board session out", () => {
  it("and it doesn't come back as a resume row", () => {
    const tabs = [tab("t1", "p1")]
    const g = reduceAgentEvents([
      { event: "SessionStart", sessionId: "a", paneId: "p1", cwd: "/a" },
    ])
    const list = [{ ...past("a", 3), cwd: "/b" }] // listed under its first folder
    const { groups } = activeGroups({
      graph: g,
      tabs,
      activeTabId: "t1",
      past: pastIndex(list),
      open: new Map([["claude:a", "p1"]]),
      shows: (_a, cwd) => cwd === "/b", // "This folder" on /b: the board says it's in /a
    })
    expect(groups).toEqual([])
  })
})
