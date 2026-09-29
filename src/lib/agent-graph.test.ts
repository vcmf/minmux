import { describe, it, expect } from "vitest"
import {
  reduceAgentEvent,
  reduceAgentEvents,
  emptyGraph,
  claudePaneIds,
  dropPaneSessions,
} from "./agent-graph"
import type { AgentEvent } from "./agent-graph"

// Authentic fixture: the interactive 6a spike run, where the root launched an
// `Explore` sub-agent that read several docs. Trimmed to the shape the receiver emits.
const S = "sess-1"
const A = "expl-1"
const EXPLORE_RUN: AgentEvent[] = [
  { event: "SessionStart", sessionId: S, cwd: "/repo" },
  { event: "UserPromptSubmit", sessionId: S },
  { event: "PreToolUse", sessionId: S, toolName: "Agent" }, // root launches the sub-agent
  { event: "SubagentStart", sessionId: S, agentId: A, agentType: "Explore" },
  { event: "PreToolUse", sessionId: S, agentId: A, toolName: "Bash" },
  {
    event: "PreToolUse",
    sessionId: S,
    agentId: A,
    toolName: "Read",
    filePath: "/repo/docs/ARCHITECTURE.md",
  },
  {
    event: "PostToolUse",
    sessionId: S,
    agentId: A,
    toolName: "Read",
    filePath: "/repo/docs/ARCHITECTURE.md",
  },
  {
    event: "PreToolUse",
    sessionId: S,
    agentId: A,
    toolName: "Read",
    filePath: "/repo/docs/ROADMAP.md",
  },
  {
    event: "PostToolUse",
    sessionId: S,
    agentId: A,
    toolName: "Read",
    filePath: "/repo/docs/ROADMAP.md",
  },
  { event: "PostToolUse", sessionId: S, agentId: A, toolName: "Bash" },
  { event: "SubagentStop", sessionId: S, agentId: A, message: "Summary: this is minmux." },
  { event: "PostToolUse", sessionId: S, toolName: "Agent" }, // root's Agent tool completes
  { event: "Stop", sessionId: S },
  { event: "Notification", sessionId: S, message: "needs your input" },
  { event: "SessionEnd", sessionId: S },
]

// The live session (everything up to SessionEnd) — what the board shows while the
// session is open. SessionEnd evicts it (tested separately in "lifecycle").
const EXPLORE_LIVE = EXPLORE_RUN.slice(0, -1)

describe("agent-graph — the interactive Explore run", () => {
  it("reconstructs one root with one Explore sub-agent", () => {
    const g = reduceAgentEvents(EXPLORE_LIVE)
    expect(g.rootIds).toEqual(["root:sess-1"])
    const root = g.nodes["root:sess-1"]!
    expect(root.agentType).toBe("root")
    expect(root.childIds).toEqual([A])
    const sub = g.nodes[A]!
    expect(sub.agentType).toBe("Explore")
    expect(sub.parentId).toBe("root:sess-1")
  })

  it("attributes the sub-agent's file reads to the sub-agent (most-recent-first)", () => {
    const g = reduceAgentEvents(EXPLORE_LIVE)
    expect(g.nodes[A]!.recentFiles).toEqual(["/repo/docs/ROADMAP.md", "/repo/docs/ARCHITECTURE.md"])
    expect(g.nodes["root:sess-1"]!.recentFiles).toEqual([]) // root read nothing itself
  })

  it("marks the sub-agent done with its final message; clears its current tool", () => {
    const g = reduceAgentEvents(EXPLORE_LIVE)
    expect(g.nodes[A]!.status).toBe("done")
    expect(g.nodes[A]!.currentTool).toBeUndefined()
    expect(g.nodes[A]!.lastMessage).toBe("Summary: this is minmux.")
  })
})

describe("agent-graph — status transitions", () => {
  const upto = (event: string) => {
    const i = EXPLORE_RUN.findIndex((e) => e.event === event)
    return reduceAgentEvents(EXPLORE_RUN.slice(0, i + 1))
  }

  it("sub-agent is working (with its current tool) mid-run", () => {
    // up to the first Explore 'Read' PreToolUse
    const g = reduceAgentEvents(EXPLORE_RUN.slice(0, 6))
    expect(g.nodes[A]!.status).toBe("working")
    expect(g.nodes[A]!.currentTool).toBe("Read")
  })

  it("Notification flips the root to waiting (needs attention)", () => {
    expect(upto("Notification").nodes["root:sess-1"]!.status).toBe("waiting")
  })

  it("Stop leaves the root idle", () => {
    expect(upto("Stop").nodes["root:sess-1"]!.status).toBe("idle")
  })
})

describe("agent-graph — lifecycle (prune finished + evict sessions)", () => {
  const finishedTurn = (): AgentEvent[] => [
    { event: "SessionStart", sessionId: S },
    { event: "UserPromptSubmit", sessionId: S },
    { event: "SubagentStart", sessionId: S, agentId: A, agentType: "Explore" },
    { event: "SubagentStop", sessionId: S, agentId: A, message: "done" },
    { event: "Stop", sessionId: S },
  ]

  it("a new turn prunes the previous turn's finished sub-agents", () => {
    const g1 = reduceAgentEvents(finishedTurn())
    expect(g1.nodes[A]!.status).toBe("done")
    expect(g1.nodes["root:sess-1"]!.childIds).toEqual([A])

    // New question → the finished Explore is dropped, session goes back to working.
    const g2 = reduceAgentEvent(g1, { event: "UserPromptSubmit", sessionId: S })
    expect(g2.nodes[A]).toBeUndefined()
    expect(g2.nodes["root:sess-1"]!.childIds).toEqual([])
    expect(g2.nodes["root:sess-1"]!.status).toBe("working")

    // The new turn's sub-agent stands alone.
    const g3 = reduceAgentEvent(g2, {
      event: "SubagentStart",
      sessionId: S,
      agentId: "b2",
      agentType: "general-purpose",
    })
    expect(g3.nodes["root:sess-1"]!.childIds).toEqual(["b2"])
  })

  it("keeps a still-active sub-agent across a new turn", () => {
    const g = reduceAgentEvents([
      { event: "SessionStart", sessionId: S },
      { event: "SubagentStart", sessionId: S, agentId: A, agentType: "Explore" }, // still working
      { event: "UserPromptSubmit", sessionId: S },
    ])
    expect(g.nodes[A]!.status).toBe("working")
    expect(g.nodes["root:sess-1"]!.childIds).toEqual([A])
  })

  it("SessionEnd evicts the whole session (root + sub-agents) and drops it from rootIds", () => {
    const g = reduceAgentEvents([...finishedTurn(), { event: "SessionEnd", sessionId: S }])
    expect(g.rootIds).toEqual([])
    expect(g.nodes["root:sess-1"]).toBeUndefined()
    expect(g.nodes[A]).toBeUndefined()
  })
})

describe("agent-graph — token usage", () => {
  const tk = { context: 9110, output: 50 }

  it("attaches session tokens to the root and sub-agent tokens to the sub-agent", () => {
    const g = reduceAgentEvents([
      { event: "SessionStart", sessionId: S },
      { event: "SubagentStart", sessionId: S, agentId: A, agentType: "Explore" },
      { event: "TokenUsage", sessionId: S, tokens: tk },
      { event: "TokenUsage", sessionId: S, agentId: A, tokens: { ...tk, output: 7 } },
    ])
    expect(g.nodes["root:sess-1"]!.tokens).toEqual(tk)
    expect(g.nodes[A]!.tokens!.output).toBe(7)
  })

  it("ignores a late token total for an already-dropped sub-agent (no resurrection)", () => {
    // Finish + prune the sub-agent, THEN a straggler TokenUsage arrives for it.
    const g1 = reduceAgentEvents([
      { event: "SessionStart", sessionId: S },
      { event: "SubagentStart", sessionId: S, agentId: A, agentType: "Explore" },
      { event: "SubagentStop", sessionId: S, agentId: A },
      { event: "Stop", sessionId: S },
      { event: "UserPromptSubmit", sessionId: S }, // prunes the finished sub-agent
    ])
    expect(g1.nodes[A]).toBeUndefined()
    const g2 = reduceAgentEvent(g1, { event: "TokenUsage", sessionId: S, agentId: A, tokens: tk })
    expect(g2.nodes[A]).toBeUndefined() // not recreated
  })

  it("ignores token totals for an unknown session (no root created)", () => {
    const g = reduceAgentEvent(emptyGraph, { event: "TokenUsage", sessionId: S, tokens: tk })
    expect(g).toBe(emptyGraph)
  })
})

describe("agent-graph — attribution & edges", () => {
  it("a root tool call updates the root, not the sub-agent", () => {
    const g = reduceAgentEvents([
      { event: "SessionStart", sessionId: S },
      { event: "SubagentStart", sessionId: S, agentId: A, agentType: "Explore" },
      { event: "PreToolUse", sessionId: S, toolName: "Edit", filePath: "/repo/x.ts" }, // root, no agentId
    ])
    expect(g.nodes["root:sess-1"]!.currentTool).toBe("Edit")
    expect(g.nodes["root:sess-1"]!.recentFiles).toEqual(["/repo/x.ts"])
    expect(g.nodes[A]!.currentTool).toBeUndefined()
    expect(g.nodes[A]!.recentFiles).toEqual([])
  })

  it("records the pane id on the session root (for grouping + click-to-focus)", () => {
    const g = reduceAgentEvents([{ event: "SessionStart", sessionId: S, paneId: "pane-9" }])
    expect(g.nodes["root:sess-1"]!.paneId).toBe("pane-9")
  })

  it("lazily creates a sub-agent node if a tool event precedes its SubagentStart", () => {
    const g = reduceAgentEvents([
      { event: "SessionStart", sessionId: S },
      {
        event: "PreToolUse",
        sessionId: S,
        agentId: A,
        agentType: "general-purpose",
        toolName: "Grep",
      },
    ])
    expect(g.nodes["root:sess-1"]!.childIds).toEqual([A])
    expect(g.nodes[A]!.agentType).toBe("general-purpose")
    expect(g.nodes[A]!.currentTool).toBe("Grep")
  })
})

describe("agent-graph — sessions & edge cases", () => {
  it("evicts an opened-then-closed session; live sessions remain", () => {
    const g = reduceAgentEvents([
      { event: "SessionStart", sessionId: "s-a" },
      { event: "SessionEnd", sessionId: "s-a" }, // opened then closed, no prompt → evicted
      { event: "SessionStart", sessionId: "s-b" },
      { event: "UserPromptSubmit", sessionId: "s-b" },
    ])
    expect(g.rootIds).toEqual(["root:s-b"])
    expect(g.nodes["root:s-a"]).toBeUndefined()
    expect(g.nodes["root:s-b"]!.status).toBe("working")
  })

  it("caps recentFiles at 10, most-recent-first", () => {
    const events: AgentEvent[] = [{ event: "SessionStart", sessionId: S }]
    for (let i = 0; i < 15; i++)
      events.push({ event: "FileChanged", sessionId: S, filePath: `/repo/f${i}.ts` })
    const files = reduceAgentEvents(events).nodes["root:sess-1"]!.recentFiles
    expect(files).toHaveLength(10)
    expect(files[0]).toBe("/repo/f14.ts")
    expect(files[9]).toBe("/repo/f5.ts")
  })

  it("dedupes a repeated file to the front", () => {
    const g = reduceAgentEvents([
      { event: "SessionStart", sessionId: S },
      { event: "FileChanged", sessionId: S, filePath: "/repo/a.ts" },
      { event: "FileChanged", sessionId: S, filePath: "/repo/b.ts" },
      { event: "FileChanged", sessionId: S, filePath: "/repo/a.ts" },
    ])
    expect(g.nodes["root:sess-1"]!.recentFiles).toEqual(["/repo/a.ts", "/repo/b.ts"])
  })

  it("ignores unknown events without throwing or mutating the input graph", () => {
    const before = reduceAgentEvents([{ event: "SessionStart", sessionId: S }])
    const after = reduceAgentEvent(before, { event: "SomethingNew", sessionId: S })
    expect(after.nodes["root:sess-1"]!.status).toBe(before.nodes["root:sess-1"]!.status)
    // input graph object is not mutated
    expect(before.nodes["root:sess-1"]!.status).toBe("idle")
  })

  it("empty stream ⇒ empty graph", () => {
    expect(reduceAgentEvents([])).toEqual(emptyGraph)
  })
})

describe("agent-graph — worktrees", () => {
  it("records a created worktree (path + branch) on the session root", () => {
    const g = reduceAgentEvents([
      { event: "SessionStart", sessionId: S, cwd: "/repo" },
      {
        event: "WorktreeCreate",
        sessionId: S,
        worktreePath: "/repo/.worktrees/feat-x",
        baseBranch: "feat/x",
      },
    ])
    expect(g.nodes["root:sess-1"]!.worktrees).toEqual([
      { path: "/repo/.worktrees/feat-x", branch: "feat/x" },
    ])
  })

  it("dedupes a repeated WorktreeCreate for the same path", () => {
    const g = reduceAgentEvents([
      { event: "SessionStart", sessionId: S },
      { event: "WorktreeCreate", sessionId: S, worktreePath: "/wt/a", baseBranch: "a" },
      { event: "WorktreeCreate", sessionId: S, worktreePath: "/wt/a", baseBranch: "a" },
    ])
    expect(g.nodes["root:sess-1"]!.worktrees).toHaveLength(1)
  })

  it("routes a worktree to the session root even when the event carries an agent_id", () => {
    const g = reduceAgentEvents([
      { event: "SessionStart", sessionId: S },
      { event: "SubagentStart", sessionId: S, agentId: A, agentType: "Explore" },
      { event: "WorktreeCreate", sessionId: S, agentId: A, worktreePath: "/wt/x", baseBranch: "x" },
    ])
    expect(g.nodes["root:sess-1"]!.worktrees).toEqual([{ path: "/wt/x", branch: "x" }])
    expect(g.nodes[A]!.worktrees).toBeUndefined() // not on the sub-agent
  })

  it("removes a worktree on WorktreeRemove, leaving the others", () => {
    const g = reduceAgentEvents([
      { event: "SessionStart", sessionId: S },
      { event: "WorktreeCreate", sessionId: S, worktreePath: "/wt/a", baseBranch: "a" },
      { event: "WorktreeCreate", sessionId: S, worktreePath: "/wt/b", baseBranch: "b" },
      { event: "WorktreeRemove", sessionId: S, worktreePath: "/wt/a" },
    ])
    expect(g.nodes["root:sess-1"]!.worktrees).toEqual([{ path: "/wt/b", branch: "b" }])
  })
})

describe("claudePaneIds / dropPaneSessions", () => {
  const g = reduceAgentEvents([
    { event: "SessionStart", sessionId: "a", paneId: "p2" },
    { event: "SessionStart", sessionId: "b", paneId: "p1" },
    { event: "SubagentStart", sessionId: "b", agentId: "sub", agentType: "Explore" },
    { event: "SessionStart", sessionId: "c", paneId: "p1" }, // a nested `claude -p`
    { event: "SessionStart", sessionId: "d" }, // no pane (claude outside minmux's panes)
  ])

  it("lists each pane with a live session once, sorted; SessionEnd removes it", () => {
    expect(claudePaneIds(g)).toEqual(["p1", "p2"])
    const ended = reduceAgentEvent(g, { event: "SessionEnd", sessionId: "a", paneId: "p2" })
    expect(claudePaneIds(ended)).toEqual(["p1"])
  })

  it("drops every session of a pane (incl. sub-agents) when its shell prompt returns", () => {
    const next = dropPaneSessions(g, "p1")
    expect(claudePaneIds(next)).toEqual(["p2"])
    expect(next.nodes.sub).toBeUndefined()
    expect(next.rootIds).toHaveLength(2) // a + the pane-less d
  })

  it("same reference when the pane had no session; the pane list is memoized per graph", () => {
    expect(dropPaneSessions(g, "nope")).toBe(g)
    expect(claudePaneIds(g)).toBe(claudePaneIds(g))
  })
})

describe("SessionStart re-homes a session", () => {
  it("the same session started again in another pane (resume after a crash) moves there", () => {
    const g = reduceAgentEvents([
      { event: "SessionStart", sessionId: "s", paneId: "a" },
      { event: "SessionStart", sessionId: "s", paneId: "b", source: "resume" },
    ])
    expect(claudePaneIds(g)).toEqual(["b"])
  })

  it("a restart never reorders the board (/compact, resume in place or in another pane)", () => {
    const g = reduceAgentEvents([
      { event: "SessionStart", sessionId: "a", paneId: "p" },
      { event: "SessionStart", sessionId: "b", paneId: "q" },
      { event: "SessionStart", sessionId: "a", paneId: "p", source: "compact" },
    ])
    expect(g.rootIds).toEqual(["root:a", "root:b"])
    const moved = reduceAgentEvent(g, { event: "SessionStart", sessionId: "a", paneId: "r" })
    expect(moved.rootIds).toEqual(["root:a", "root:b"])
  })
})
