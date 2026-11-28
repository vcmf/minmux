import { describe, expect, it } from "vitest"
import { emptyGraph, reduceAgentEvent, type AgentEvent } from "./agent-graph"
import { makeLeaf, splitNode } from "./pane-tree"
import { buildRemotePanes, samePanes } from "./remote-panes"
import type { Session, Tab } from "../types"

const session = (id: string, over: Partial<Session> = {}): Session => ({
  id,
  title: "zsh",
  command: "/bin/zsh",
  args: [],
  status: "idle",
  unread: false,
  cwd: `/Users/me/${id}`,
  ...over,
})

const tab = (id: string, root: Tab["root"], first: string): Tab => ({
  id,
  title: "",
  root,
  activeEntryId: first,
  activeSessionId: first,
})

const graph = (events: AgentEvent[]) => events.reduce(reduceAgentEvent, emptyGraph)

describe("buildRemotePanes", () => {
  const tabs = [
    tab("t1", splitNode(makeLeaf("p1", "a"), "a", "row", "b", "s", "p2"), "a"),
    tab("t2", makeLeaf("p3", "c"), "c"),
  ]

  it("lists every terminal by tab, with agent status from the agent graph", () => {
    const sessions = {
      // The sidebar's signals say idle (the pane is in view); the agent is waiting.
      a: session("a", { status: "idle" }),
      b: session("b", { status: "working" }),
      c: session("c", { status: "attention", detail: "bell" }),
    }
    const agents = graph([
      { event: "SessionStart", sessionId: "s1", paneId: "a", cwd: "/Users/me/a" },
      {
        event: "Notification",
        sessionId: "s1",
        paneId: "a",
        message: "Claude needs your permission",
      },
    ])
    const r = buildRemotePanes({
      tabs,
      sessions,
      agents,
      home: "/Users/me",
      started: (id) => id !== "c",
      color: () => "#f0913d", // asked for agent panes only
    })
    expect(r.tabs.map((t) => t.id)).toEqual(["t1", "t2"])
    expect(r.panes).toEqual([
      {
        id: "a",
        tab: "t1",
        title: "a",
        kind: "agent",
        agent: "claude",
        color: "#f0913d",
        status: "waiting",
        detail: "Claude needs your permission",
        cwd: "/Users/me/a",
        started: true,
      },
      {
        id: "b",
        tab: "t1",
        title: "b",
        kind: "shell",
        status: "working",
        cwd: "/Users/me/b",
        started: true,
      },
      {
        id: "c",
        tab: "t2",
        title: "c",
        kind: "shell",
        status: "waiting",
        detail: "bell",
        cwd: "/Users/me/c",
        started: false,
      },
    ])
    expect(r.stale).toBe(false)
  })

  it("marks ssh panes and skips ids without a session", () => {
    const sessions = {
      a: session("a", {
        remote: { hostId: "h", target: "gpu", label: "gpu", env: "native" } as Session["remote"],
      }),
    }
    const r = buildRemotePanes({
      tabs,
      sessions,
      agents: emptyGraph,
      home: "/Users/me",
      started: () => true,
    })
    expect(r.panes).toHaveLength(1)
    expect(r.panes[0]).toMatchObject({ id: "a", kind: "ssh", title: "gpu" })
    expect(r.panes[0]!.cwd).toBeUndefined() // no local folder
  })

  it("samePanes compares content", () => {
    const sessions = { a: session("a"), b: session("b"), c: session("c") }
    const one = buildRemotePanes({
      tabs,
      sessions,
      agents: emptyGraph,
      home: "/Users/me",
      started: () => true,
    })
    const two = buildRemotePanes({
      tabs,
      sessions,
      agents: emptyGraph,
      home: "/Users/me",
      started: () => true,
    })
    expect(samePanes(one, two)).toBe(true)
    expect(samePanes(null, two)).toBe(false)
  })
})
