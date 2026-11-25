// The fleet graph's model (docs/design/FLEET_GRAPH.md, "Data"): repos → PRs (or a branch with
// no PR) → agent sessions → sub-agents, built from what minmux already tracks. Pure.
//  - An agent works in its own checkout, by the sidebar's rule (agent-dirs): its `in` folder
//    when it works elsewhere than the pane's shell, else the pane's.
//  - Only repos with a live agent session are shown; in them, my open PRs with nobody on them
//    show too.
import type { AgentGraph, AgentKind, AgentNode, AgentStatus, TokenUsage } from "./agent-graph"
import { paneLeads } from "./agent-graph"
import { agentWorkDirs, gitKey, samePath, worksElsewhere } from "./agent-dirs"
import type { PaneGitInfo, PrState } from "./pane-git"
import type { PrRow } from "./pr-dashboard"
import type { LocalRepo } from "./pr-local"
import type { SessionMeta } from "./session-color"
import type { Session } from "../types"

export interface FleetSub {
  id: string
  type: string // the sub-agent type ("Explore", "Plan", …)
  status: AgentStatus
}

export interface FleetAgent {
  id: string // the session root's node id
  sessionId: string
  paneId: string
  kind: AgentKind
  status: AgentStatus
  name?: string // /rename or the agent's own title
  color?: string | null
  cwd?: string
  branch?: string
  currentTool?: string
  tokens?: TokenUsage
  subs: FleetSub[]
}

export interface FleetPr {
  url: string
  number: number
  state: PrState
  row?: PrRow // title, CI, review…: when the lists hold it
  agents: FleetAgent[]
}

export interface FleetBranch {
  name: string
  agents: FleetAgent[]
}

export interface FleetRepo {
  key: string // `owner/name` lowercased, or the checkout root when it has no GitHub remote
  label: string // `owner/name`, or the folder's name
  repo?: string // `owner/name` (GitHub)
  defaultBranch?: string
  prs: FleetPr[]
  branches: FleetBranch[]
  agents: FleetAgent[] // on the default branch (no PR, no branch node)
  counts: { agents: number; working: number; waiting: number; prs: number }
}

export interface FleetInput {
  agents: AgentGraph
  paneGit: Record<string, PaneGitInfo>
  sessions: Record<string, Pick<Session, "cwd">>
  meta: Record<string, SessionMeta>
  local: LocalRepo[] // prs:local: each repo's GitHub name, worktrees, default branch
  mine: PrRow[] // my open PRs (the lists' `mine`)
}

const isLive = (s: PrState) => s === "open" || s === "draft"
const folderName = (p: string) =>
  p
    .replace(/[\\/]+$/, "")
    .split(/[\\/]/)
    .pop() || p

/** The git answer for the checkout a pane's agent works in (the sidebar's rule). */
export function agentGit(
  graph: AgentGraph,
  paneGit: Record<string, PaneGitInfo>,
  paneId: string,
  shellCwd?: string,
): PaneGitInfo | undefined {
  const dir = agentWorkDirs(graph)[paneId]
  const inGit = paneGit[gitKey(paneId, "in")]
  return worksElsewhere(shellCwd, dir?.cwd, paneGit[paneId], inGit, dir?.agent)
    ? inGit
    : paneGit[paneId]
}

/** The local repo a checkout root belongs to (one of its worktrees). */
function repoOfRoot(local: LocalRepo[], root: string): LocalRepo | undefined {
  return local.find((r) => r.worktrees.some((w) => samePath(w.path, root)))
}

function toAgent(
  graph: AgentGraph,
  n: AgentNode,
  paneId: string,
  input: FleetInput,
  git?: PaneGitInfo,
): FleetAgent {
  const meta = input.meta[paneId]
  return {
    id: n.id,
    sessionId: n.sessionId,
    paneId,
    kind: n.agent,
    status: n.status,
    ...(meta?.name ? { name: meta.name } : {}),
    ...(meta?.color !== undefined ? { color: meta.color } : {}),
    ...(n.cwd ? { cwd: n.cwd } : {}),
    ...(git?.branch ? { branch: git.branch } : {}),
    ...(n.currentTool ? { currentTool: n.currentTool } : {}),
    ...(n.tokens ? { tokens: n.tokens } : {}),
    subs: n.childIds.flatMap((id) => {
      const c = graph.nodes[id]
      return c ? [{ id: c.id, type: c.agentType, status: c.status }] : []
    }),
  }
}

/** Repos with a live agent session, in the order their first agent appeared. */
export function fleetModel(input: FleetInput): FleetRepo[] {
  const { agents: graph, paneGit, sessions, local, mine } = input
  const repos = new Map<string, FleetRepo>()
  const rowsByUrl = new Map(mine.map((r) => [r.url, r]))

  // Each pane's lead session (a background agent in the same pane isn't the pane's agent), in
  // the board's order.
  const leads = paneLeads(graph)
  const order = graph.rootIds.flatMap((id) => {
    const n = graph.nodes[id]
    return n?.paneId && leads[n.paneId] === n && sessions[n.paneId] ? [n] : []
  })

  for (const n of order) {
    const paneId = n.paneId!
    const git = agentGit(graph, paneGit, paneId, sessions[paneId]?.cwd)
    const root = git?.root
    if (!root) continue // not in a repo (or not looked up yet)
    const loc = repoOfRoot(local, root)
    const gh = loc?.repo ?? undefined
    const key = gh ? gh.toLowerCase() : root
    let repo = repos.get(key)
    if (!repo) {
      const defaultBranch =
        loc?.defaultBranch ?? mine.find((r) => gh && r.repo.toLowerCase() === key)?.defaultBranch
      repo = {
        key,
        label: gh ?? folderName(root),
        ...(gh ? { repo: gh } : {}),
        ...(defaultBranch ? { defaultBranch } : {}),
        prs: [],
        branches: [],
        agents: [],
        counts: { agents: 0, working: 0, waiting: 0, prs: 0 },
      }
      repos.set(key, repo)
    }
    const agent = toAgent(graph, n, paneId, input, git)
    repo.counts.agents++
    if (agent.status === "working") repo.counts.working++
    if (agent.status === "waiting") repo.counts.waiting++

    const pr = git?.pr && isLive(git.pr.state) ? git.pr : undefined
    if (pr) {
      let node = repo.prs.find((p) => p.url === pr.url)
      if (!node) {
        const row = rowsByUrl.get(pr.url)
        node = {
          url: pr.url,
          number: pr.number,
          state: pr.state,
          ...(row ? { row } : {}),
          agents: [],
        }
        repo.prs.push(node)
      }
      node.agents.push(agent)
    } else if (git?.branch && git.branch !== repo.defaultBranch) {
      let b = repo.branches.find((x) => x.name === git.branch)
      if (!b) repo.branches.push((b = { name: git.branch, agents: [] }))
      b.agents.push(agent)
    } else repo.agents.push(agent)
  }

  // My open PRs with nobody on them, in the repos shown (the lists' order).
  for (const row of mine) {
    if (row.state !== "open" && row.state !== "draft") continue
    const repo = repos.get(row.repo.toLowerCase())
    if (!repo || repo.prs.some((p) => p.url === row.url)) continue
    repo.prs.push({ url: row.url, number: row.number, state: row.state, row, agents: [] })
  }
  for (const repo of repos.values()) repo.counts.prs = repo.prs.length
  return [...repos.values()]
}
