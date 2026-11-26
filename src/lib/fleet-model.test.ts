import { describe, it, expect } from "vitest"
import { DETACHED, fleetModel, type FleetInput } from "./fleet-model"
import { reduceAgentEvents, type AgentEvent } from "./agent-graph"
import type { PaneGitInfo } from "./pane-git"
import type { PrRow } from "./pr-dashboard"
import type { LocalRepo } from "./pr-local"
import type { PaneWork } from "./agent-work"

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
    paneWork: {},
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
      {
        name: "feat",
        agents: [expect.objectContaining({ sessionId: "s1" })],
        linked: [],
        dirs: ["/w/r-wt"],
      },
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

  it("a detached checkout still finds its repo (by the roots asked about), on a detached node", () => {
    const local: LocalRepo[] = [{ ...localR, roots: ["/w/r-detached"] }]
    const m = fleetModel(
      input(session("s1", "p1", "/w/r-detached"), { p1: { root: "/w/r-detached" } }, { local }),
    )
    expect(m).toHaveLength(1)
    expect(m[0]!.key).toBe("o/r")
    expect(m[0]!.branches.map((b) => b.name)).toEqual([DETACHED])
    expect(m[0]!.agents).toEqual([])
  })

  it("GitHub's default branch wins over a stale local remote HEAD", () => {
    const local: LocalRepo[] = [{ ...localR, defaultBranch: "master" }]
    const m = fleetModel(
      input(
        session("s1", "p1", "/w/r"),
        { p1: { root: "/w/r", branch: "main" } },
        {
          local,
          mine: [row(3, { defaultBranch: "main" })],
        },
      ),
    )
    expect(m[0]!.defaultBranch).toBe("main")
    expect(m[0]!.agents).toHaveLength(1)
  })

  it("keeps an agent in a checkout main's git can't read (WSL), keyed by its folder", () => {
    const m = fleetModel(
      input(session("s1", "p1", "/home/u/r"), { p1: { root: "/home/u/r", branch: "main" } }),
    )
    expect(m).toHaveLength(1)
    expect(m[0]).toMatchObject({ key: "/home/u/r", label: "r" })
    expect(m[0]!.repo).toBeUndefined()
  })

  describe("every checkout an agent touches", () => {
    const work = (session: string, shown: string, more: string[] = []): PaneWork => ({
      session,
      agent: "claude",
      dirs: {},
      shown,
      more,
    })
    const local: LocalRepo[] = [
      {
        ...localR,
        worktrees: [...localR.worktrees, { path: "/w/r-fix", branch: "fix" }],
      },
      { repo: "o/b", defaultBranch: "main", worktrees: [{ path: "/w/b", branch: "main" }] },
    ]

    it("an agent started outside any repo hangs on the PR of the checkout it edits", () => {
      const m = fleetModel(
        input(
          session("s1", "p1", "/home/u/notes"),
          {
            p1: { noRepo: true },
            "p1@edit": { root: "/w/r-wt", branch: "feat", pr: pr(7), forCwd: "/w/r-wt" },
          },
          { paneWork: { p1: work("s1", "/w/r-wt") }, local },
        ),
      )
      expect(m).toHaveLength(1)
      expect(m[0]!.prs[0]).toMatchObject({ number: 7, dirs: ["/w/r-wt"], linked: [] })
      expect(m[0]!.prs[0]!.agents[0]).toMatchObject({ sessionId: "s1", dir: "/w/r-wt" })
    })

    it("placed by its edits, linked to its shell's PR and a +N checkout's PR (by branch)", () => {
      const m = fleetModel(
        input(
          session("s1", "p1", "/w/r"),
          {
            p1: { root: "/w/r", branch: "main" },
            "p1@edit": { root: "/w/r-wt", branch: "feat", pr: pr(7), forCwd: "/w/r-wt" },
          },
          {
            paneWork: { p1: work("s1", "/w/r-wt", ["/w/r-fix"]) },
            local,
            mine: [row(9, { head: "fix", fork: false })],
          },
        ),
      )
      const r = m[0]!
      expect(r.counts.agents).toBe(1)
      expect(r.agents).toEqual([]) // (the default branch: not a place of its own here)
      const p7 = r.prs.find((p) => p.number === 7)!
      const p9 = r.prs.find((p) => p.number === 9)!
      expect(p7.agents.map((a) => a.sessionId)).toEqual(["s1"])
      expect(p9.agents).toEqual([])
      expect(p9.linked.map((a) => a.sessionId)).toEqual(["s1"])
      expect(p9.dirs).toEqual(["/w/r-fix"])
      expect(p9.row?.title).toBe("PR 9")
    })

    it("a fork's PR of the same branch name isn't its checkout's", () => {
      const m = fleetModel(
        input(
          session("s1", "p1", "/w/r-fix"),
          { p1: { root: "/w/r-fix", branch: "fix" } },
          { local, mine: [row(9, { head: "fix", fork: true })] },
        ),
      )
      expect(m[0]!.branches.map((b) => b.name)).toEqual(["fix"])
      expect(m[0]!.prs.find((p) => p.number === 9)!.dirs).toEqual([])
    })

    it("an agent touching two repos is in both, placed in each", () => {
      const m = fleetModel(
        input(
          session("s1", "p1", "/w/b"),
          {
            p1: { root: "/w/b", branch: "main" },
            "p1@edit": { root: "/w/r-wt", branch: "feat", pr: pr(7), forCwd: "/w/r-wt" },
          },
          { paneWork: { p1: work("s1", "/w/r-wt") }, local },
        ),
      )
      expect(m.map((r) => r.key)).toEqual(["o/r", "o/b"])
      expect(m[0]!.prs[0]!.agents[0]).toMatchObject({ sessionId: "s1", dir: "/w/r-wt" })
      expect(m[1]!.agents[0]).toMatchObject({ sessionId: "s1", dir: "/w/b", branch: "main" })
      expect(m.map((r) => r.counts.agents)).toEqual([1, 1])
    })

    it("an older session's edits aren't the new one's; an answer for another folder neither", () => {
      const m = fleetModel(
        input(
          session("s2", "p1", "/w/r"),
          {
            p1: { root: "/w/r", branch: "main" },
            "p1@edit": { root: "/w/r-wt", branch: "feat", pr: pr(7), forCwd: "/w/other" },
          },
          { paneWork: { p1: work("s1", "/w/r-wt", ["/w/r-fix"]) }, local },
        ),
      )
      expect(m[0]!.agents.map((a) => a.sessionId)).toEqual(["s2"])
      expect(m[0]!.prs).toEqual([])
      expect(m[0]!.branches).toEqual([])
    })

    it("my PR with nobody on it says where it's checked out", () => {
      const m = fleetModel(
        input(
          session("s1", "p1", "/w/r"),
          { p1: { root: "/w/r", branch: "main" } },
          { local, mine: [row(9, { head: "fix", fork: false })] },
        ),
      )
      expect(m[0]!.prs[0]).toMatchObject({ number: 9, dirs: ["/w/r-fix"], agents: [] })
    })
  })
})
