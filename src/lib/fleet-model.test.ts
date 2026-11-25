import { describe, it, expect } from "vitest"
import { fleetModel, type FleetInput } from "./fleet-model"
import { reduceAgentEvents, type AgentEvent } from "./agent-graph"
import type { PaneGitInfo } from "./pane-git"
import type { PrRow } from "./pr-dashboard"
import type { LocalRepo } from "./pr-local"

// A session in pane `pane`, started in `cwd`, working (a prompt was sent).
const session = (sessionId: string, pane: string, cwd: string): AgentEvent[] => [
  { event: "SessionStart", sessionId, cwd, paneId: pane },
  { event: "UserPromptSubmit", sessionId },
]
const pr = (n: number, state: "open" | "draft" = "open") => ({
  number: n,
  state,
  url: `https://github.com/o/r/pull/${n}`,
})
const row = (n: number, over: Partial<PrRow> = {}): PrRow =>
  ({
    number: n,
    title: `PR ${n}`,
    url: `https://github.com/o/r/pull/${n}`,
    repo: "o/r",
    defaultBranch: "main",
    state: "open",
    ci: "pending",
    ...over,
  }) as PrRow
const localR: LocalRepo = {
  repo: "o/r",
  defaultBranch: "main",
  worktrees: [
    { path: "/w/r", branch: "main" },
    { path: "/w/r-wt", branch: "feat" },
  ],
}

function input(
  events: AgentEvent[],
  paneGit: Record<string, PaneGitInfo>,
  over: Partial<FleetInput> = {},
): FleetInput {
  const panes = new Set(events.flatMap((e) => (e.paneId ? [e.paneId] : [])))
  return {
    agents: reduceAgentEvents(events),
    paneGit,
    sessions: Object.fromEntries([...panes].map((p) => [p, { cwd: paneGit[p]?.root ?? "/" }])),
    meta: {},
    local: [localR],
    mine: [],
    ...over,
  }
}

describe("fleetModel", () => {
  it("puts an agent on its checkout's PR, with the PR's row when the lists hold it", () => {
    const m = fleetModel(
      input(
        session("s1", "p1", "/w/r-wt"),
        { p1: { root: "/w/r-wt", branch: "feat", pr: pr(7) } },
        {
          mine: [row(7)],
        },
      ),
    )
    expect(m).toHaveLength(1)
    expect(m[0]).toMatchObject({ key: "o/r", label: "o/r", defaultBranch: "main" })
    expect(m[0]!.prs).toHaveLength(1)
    expect(m[0]!.prs[0]!.row?.title).toBe("PR 7")
    expect(m[0]!.prs[0]!.agents.map((a) => a.sessionId)).toEqual(["s1"])
    expect(m[0]!.counts).toEqual({ agents: 1, working: 1, waiting: 0, prs: 1 })
  })

  it("groups agents on the same PR under one node, without a row when the lists don't hold it", () => {
    const m = fleetModel(
      input([...session("s1", "p1", "/w/r-wt"), ...session("s2", "p2", "/w/r-wt")], {
        p1: { root: "/w/r-wt", branch: "feat", pr: pr(7) },
        p2: { root: "/w/r-wt", branch: "feat", pr: pr(7) },
      }),
    )
    expect(m[0]!.prs).toHaveLength(1)
    expect(m[0]!.prs[0]!.row).toBeUndefined() // number and state only
    expect(m[0]!.prs[0]!.agents).toHaveLength(2)
  })

  it("a branch with no PR is a branch node; the default branch hangs off the repo", () => {
    const m = fleetModel(
      input([...session("s1", "p1", "/w/r-wt"), ...session("s2", "p2", "/w/r")], {
        p1: { root: "/w/r-wt", branch: "feat" },
        p2: { root: "/w/r", branch: "main" },
      }),
    )
    expect(m[0]!.branches).toEqual([
      { name: "feat", agents: [expect.objectContaining({ sessionId: "s1" })] },
    ])
    expect(m[0]!.agents.map((a) => a.sessionId)).toEqual(["s2"])
    expect(m[0]!.prs).toEqual([])
  })

  it("a closed or merged PR doesn't count: the agent sits on its branch", () => {
    const m = fleetModel(
      input(session("s1", "p1", "/w/r-wt"), {
        p1: { root: "/w/r-wt", branch: "feat", pr: { ...pr(7), state: "merged" } },
      }),
    )
    expect(m[0]!.prs).toEqual([])
    expect(m[0]!.branches[0]!.name).toBe("feat")
  })

  it("a repo with no GitHub remote is named after its folder", () => {
    const m = fleetModel(
      input(
        session("s1", "p1", "/w/notes"),
        { p1: { root: "/w/notes", branch: "main" } },
        { local: [] },
      ),
    )
    expect(m[0]).toMatchObject({ key: "/w/notes", label: "notes" })
    expect(m[0]!.repo).toBeUndefined()
  })

  it("shows my open PRs with nobody on them, only in repos that have an agent", () => {
    const m = fleetModel(
      input(
        session("s1", "p1", "/w/r"),
        { p1: { root: "/w/r", branch: "main" } },
        {
          mine: [
            row(3),
            row(4, { state: "draft" }),
            row(5, { repo: "o/other", url: "https://github.com/o/other/pull/5" }),
          ],
        },
      ),
    )
    expect(m).toHaveLength(1)
    expect(m[0]!.prs.map((p) => [p.number, p.agents.length])).toEqual([
      [3, 0],
      [4, 0],
    ])
  })

  it("leaves out agents not in a repo, and panes that are gone", () => {
    const events = [...session("s1", "p1", "/tmp"), ...session("s2", "p2", "/w/r")]
    const inp = input(events, { p1: { noRepo: true }, p2: { root: "/w/r", branch: "main" } })
    delete (inp.sessions as Record<string, unknown>).p2 // its pane closed
    expect(fleetModel(inp)).toEqual([])
  })

  it("counts agents that need you, lists sub-agents, and takes the name from the session's meta", () => {
    const events: AgentEvent[] = [
      ...session("s1", "p1", "/w/r"),
      { event: "SubagentStart", sessionId: "s1", agentId: "a1", agentType: "Explore" },
      { event: "PermissionRequest", sessionId: "s1", toolName: "Bash" },
    ]
    const m = fleetModel(
      input(
        events,
        { p1: { root: "/w/r", branch: "main" } },
        { meta: { p1: { name: "fleet-graph" } } },
      ),
    )
    const a = m[0]!.agents[0]!
    expect(a.name).toBe("fleet-graph")
    expect(a.subs).toEqual([expect.objectContaining({ type: "Explore" })])
    expect(m[0]!.counts.waiting).toBe(1)
  })

  it("keeps the order agents first appeared in", () => {
    const local: LocalRepo[] = [
      localR,
      { repo: "o/b", worktrees: [{ path: "/w/b", branch: "main" }] },
    ]
    const m = fleetModel(
      input(
        [...session("s1", "p1", "/w/b"), ...session("s2", "p2", "/w/r")],
        {
          p1: { root: "/w/b", branch: "main" },
          p2: { root: "/w/r", branch: "main" },
        },
        { local },
      ),
    )
    expect(m.map((r) => r.label)).toEqual(["o/b", "o/r"])
  })

  it("places an agent working in another checkout by that checkout (the sidebar's `in`)", () => {
    const inp = input(session("s1", "p1", "/w/r-wt"), {
      p1: { noRepo: true },
      "p1@in": { root: "/w/r-wt", branch: "feat", pr: pr(9), forCwd: "/w/r-wt" },
    })
    inp.sessions = { p1: { cwd: "/home/u" } } // the shell stayed home
    const m = fleetModel(inp)
    expect(m[0]!.prs.map((p) => p.number)).toEqual([9])
  })

  it("a repo with no GitHub remote stays one node across its worktrees", () => {
    const local: LocalRepo[] = [
      {
        repo: null,
        worktrees: [
          { path: "/w/proj", branch: "main" },
          { path: "/w/proj-feat", branch: "feat" },
        ],
      },
    ]
    const m = fleetModel(
      input(
        [...session("s1", "p1", "/w/proj"), ...session("s2", "p2", "/w/proj-feat")],
        { p1: { root: "/w/proj", branch: "main" }, p2: { root: "/w/proj-feat", branch: "feat" } },
        { local },
      ),
    )
    expect(m).toHaveLength(1)
    expect(m[0]).toMatchObject({ key: "/w/proj", label: "proj" })
    expect(m[0]!.agents.map((a) => a.sessionId)).toEqual(["s1"]) // main: on the repo
    expect(m[0]!.branches.map((b) => b.name)).toEqual(["feat"])
  })

  it("with no known default branch, main or master hangs off the repo", () => {
    const local: LocalRepo[] = [{ ...localR, defaultBranch: undefined }]
    const m = fleetModel(
      input(session("s1", "p1", "/w/r"), { p1: { root: "/w/r", branch: "master" } }, { local }),
    )
    expect(m[0]!.defaultBranch).toBeUndefined()
    expect(m[0]!.agents).toHaveLength(1)
    expect(m[0]!.branches).toEqual([])
  })
})
