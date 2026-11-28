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
      git: (id) =>
        id === "a" ? { branch: "main", pr: { number: 7, state: "open", url: "u" } } : undefined,
    })
    // Each tab: its focused terminal's branch • folder and shell, as the sidebar heads it.
    expect(r.tabs).toEqual([
      { id: "t1", title: expect.any(String), sub: "main • ~/a", shell: "zsh" },
      { id: "t2", title: expect.any(String), sub: "~/c", shell: "zsh" },
    ])
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
        shell: "zsh",
        branch: "main",
        where: "main • ~/a",
        pr: { number: 7, state: "open" },
        started: true,
      },
      {
        id: "b",
        tab: "t1",
        title: "b",
        kind: "shell",
        status: "working",
        cwd: "/Users/me/b",
        shell: "zsh",
        where: "~/b",
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
        shell: "zsh",
        where: "~/c",
        started: false,
      },
    ])
    expect(r.stale).toBe(false)
  })

  it("a working agent's pane carries the start of its last reply", () => {
    const agents = graph([
      { event: "SessionStart", sessionId: "s1", paneId: "a", cwd: "/Users/me/a" },
      { event: "Stop", sessionId: "s1", paneId: "a", message: "## Done\n\nAll `412` tests pass." },
      { event: "UserPromptSubmit", sessionId: "s1", paneId: "a" },
    ])
    const r = buildRemotePanes({
      tabs: [tab("t1", makeLeaf("p1", "a"), "a")],
      sessions: { a: session("a") },
      agents,
      home: "/Users/me",
      started: () => true,
    })
    expect(r.panes[0]!.snippet).toBe("Done All 412 tests pass.")
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
