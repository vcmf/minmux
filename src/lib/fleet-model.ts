// The fleet graph's model (docs/design/FLEET_GRAPH.md, "Data"): repos → PRs (or a branch with
// no PR) → agent sessions → sub-agents, built from what minmux already tracks. Pure.
//  - An agent is tied to the checkouts it works in (the sidebar's lines, each with a lookup):
//    the one it edits (`edits`), its own folder (`in`), its shell's (`from`). In each repo the
//    first of them places it; the others link it to their PR or branch. The other ones it
//    edited (the `+N`, no lookup of their own) are only listed.
//  - Only repos with a live agent session are shown; in them, my open PRs with nobody on them
//    show too.
import type {
  AgentGraph,
  AgentKind,
  AgentNode,
  AgentStatus,
  TokenUsage,
  Toolbox,
} from "./agent-graph"
import { paneLeads } from "./agent-graph"
import { agentWorkDirs, gitKey, samePath } from "./agent-dirs"
import { moreFolders, type PaneWork } from "./agent-work"
import { SLOTS, nextPlaces, type Place, type PlaceLedger } from "./fleet-places"
import type { PaneGitInfo, PrState } from "./pane-git"
import type { PrRow } from "./pr-dashboard"
import type { LocalRepo } from "./pr-local"
import { baseOf } from "./pr-stacks"
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
  nameAuto?: boolean // the agent's own title, not a /rename: it colours nothing
  cwd?: string
  dir?: string // its checkout in this repo (the card's folder)
  more?: string[] // the other checkouts it edited (no lookup of their own: listed, not linked)
  branch?: string
  currentTool?: string
  tokens?: TokenUsage
  toolbox?: Toolbox // its MCP servers and skills (after its first turn)
  subs: FleetSub[]
}

export interface FleetPr {
  url: string
  number: number
  state: PrState
  row?: PrRow // title, CI, review…: when the lists hold it
  agents: FleetAgent[] // placed under it
  linked: FleetAgent[] // placed elsewhere in the repo, touching it too
  dirs: string[] // the checkouts it's in
  on?: { url: string; number: number } // the PR it's stacked on, when that one is shown too
}

export interface FleetBranch {
  name: string
  agents: FleetAgent[]
  linked: FleetAgent[]
  dirs: string[]
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
  roots: string[] // its agents' checkout roots (stable while `key` moves from a folder to owner/name)
}

export interface FleetInput {
  agents: AgentGraph
  paneGit: Record<string, PaneGitInfo>
  sessions: Record<string, Pick<Session, "cwd">>
  paneWork: Record<string, PaneWork> // the checkouts each pane's agent edits in
  places?: PlaceLedger // where each session works (lib/fleet-places; none: from this round alone)
  meta: Record<string, SessionMeta>
  local: LocalRepo[] // prs:local: each repo's GitHub name, worktrees, default branch
  mine: PrRow[] // my open PRs (the lists' `mine`)
}

const isLive = (s: PrState) => s === "open" || s === "draft"
/** The branch node for agents on no branch (detached HEAD). */
export const DETACHED = "(detached)"
// The default branch when it's known; else the usual names (a branch node named `main` would be
// wrong far more often than right).
const isDefault = (branch: string, known?: string) =>
  known ? branch === known : branch === "main" || branch === "master"
const folderName = (p: string) =>
  p
    .replace(/[\\/]+$/, "")
    .split(/[\\/]/)
    .pop() || p

/** The agents placed in a repo (each once; one touching several repos is in each). */
export const agentsIn = (r: FleetRepo): FleetAgent[] => [
  ...r.prs.flatMap((p) => p.agents),
  ...r.branches.flatMap((b) => b.agents),
  ...r.agents,
]

/** Every agent in the fleet, once. */
export function fleetAgentsOf(repos: FleetRepo[]): FleetAgent[] {
  const seen = new Set<string>()
  return repos.flatMap((r) => agentsIn(r)).filter((a) => !seen.has(a.id) && !!seen.add(a.id))
}

/** The local repo a checkout root belongs to (asked about under it, or one of its worktrees). */
function repoOfRoot(local: LocalRepo[], root: string): LocalRepo | undefined {
  return local.find(
    (r) =>
      r.roots?.some((p) => samePath(p, root)) || r.worktrees.some((w) => samePath(w.path, root)),
  )
}

function toAgent(graph: AgentGraph, n: AgentNode, paneId: string, input: FleetInput): FleetAgent {
  const meta = input.meta[paneId]
  return {
    id: n.id,
    sessionId: n.sessionId,
    paneId,
    kind: n.agent,
    status: n.status,
    ...(meta?.name ? { name: meta.name } : {}),
    ...(meta?.color !== undefined ? { color: meta.color } : {}),
    ...(meta?.auto ? { nameAuto: true } : {}),
    ...(n.cwd ? { cwd: n.cwd } : {}),
    ...(n.currentTool ? { currentTool: n.currentTool } : {}),
    ...(n.tokens ? { tokens: n.tokens } : {}),
    ...(n.toolbox ? { toolbox: n.toolbox } : {}),
    subs: n.childIds.flatMap((id) => {
      const c = graph.nodes[id]
      return c ? [{ id: c.id, type: c.agentType, status: c.status }] : []
    }),
  }
}

// In placing order: the one it edits, its own folder, its shell's, from the ledger (each slot
// a lookup's last answer for its folder); the `+N` and an `edits` one with no branch: listed.
/** The checkouts a pane's agent works in, once each, and the other ones it edited. */
export function touched(
  input: FleetInput,
  n: AgentNode,
  paneId: string,
  ledger: PlaceLedger,
): { places: Place[]; more: string[] } {
  const { agents: graph, paneGit, paneWork } = input
  const out: Place[] = []
  const slots = ledger[n.sessionId] ?? {}
  for (const k of SLOTS) {
    const p = slots[k]
    if (p && !out.some((o) => samePath(o.root, p.root))) out.push(p)
  }
  const work = paneWork[paneId]?.session === n.sessionId ? paneWork[paneId] : undefined
  const shown = work?.shown
  const edit = paneGit[gitKey(paneId, "edit")]
  const unplacedEdit =
    !!shown &&
    !!edit?.forCwd &&
    samePath(edit.forCwd, shown) &&
    !(edit.branch || edit.pr) &&
    !!(edit.root || edit.noRepo) // (a failed lookup isn't an answer)
  const dir = agentWorkDirs(graph)[paneId]
  const more = moreFolders(
    (dir?.others ?? []).map((w) => w.path),
    [...(unplacedEdit ? [shown!] : []), ...(work?.more ?? [])],
    undefined,
  )
  return { places: out, more }
}

// Its live PR, its branch's node, or the root (the default branch); made when first needed.
/** Where a checkout ties an agent in its repo. */
function targetOf(
  repo: FleetRepo,
  place: Place,
  rowsByUrl: Map<string, PrRow>,
): FleetPr | FleetBranch | "root" {
  const pr = place.pr && isLive(place.pr.state) ? place.pr : undefined
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
        linked: [],
        dirs: [],
      }
      repo.prs.push(node)
    }
    return node
  }
  // (no branch: a detached HEAD, mid-rebase or a checked-out tag; not the default branch)
  if (place.branch && isDefault(place.branch, repo.defaultBranch)) return "root"
  const name = place.branch ?? DETACHED
  let b = repo.branches.find((x) => x.name === name)
  if (!b) repo.branches.push((b = { name, agents: [], linked: [], dirs: [] }))
  return b
}

/** Repos with a live agent session, in the order their first agent appeared. */
export function fleetModel(input: FleetInput): FleetRepo[] {
  const { agents: graph, sessions, local, mine } = input
  const ledger = input.places ?? nextPlaces({}, input)
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
    const { places: all, more: others } = touched(input, n, paneId, ledger)
    // Only checkouts a repo answer places count; with none placed yet (a WSL pane's, or before
    // the first answer) the first one's folder stands for its repo, alone: two folders could be
    // the same repo shown twice. The ones left out are listed with the `+N`.
    const known = all.filter((p) => repoOfRoot(local, p.root))
    const used = known.length ? known : all.slice(0, 1)
    const more = moreFolders(
      [],
      [...all.filter((p) => !used.includes(p)).map((p) => p.root), ...others],
    ).filter((d) => !used.some((p) => samePath(p.root, d)))
    const base = {
      ...toAgent(graph, n, paneId, input), // (its branch: per repo, below)
      ...(more.length ? { more } : {}),
    }
    // Its checkouts by repo, in the order they place it.
    const byRepo = new Map<string, Place[]>()
    for (const place of used) {
      const loc = repoOfRoot(local, place.root)
      const gh = loc?.repo ?? undefined
      // No GitHub remote: its main worktree stands for the repo (all its worktrees, one node).
      const key = gh ? gh.toLowerCase() : (loc?.worktrees[0]?.path ?? place.root)
      if (!repos.has(key)) {
        // GitHub's (on a listed PR) first: the local remote HEAD is set at clone and goes stale
        // when the default is renamed.
        const defaultBranch =
          mine.find((r) => gh && r.repo.toLowerCase() === key)?.defaultBranch ?? loc?.defaultBranch
        repos.set(key, {
          key,
          label: gh ?? folderName(key),
          ...(gh ? { repo: gh } : {}),
          ...(defaultBranch ? { defaultBranch } : {}),
          prs: [],
          branches: [],
          agents: [],
          counts: { agents: 0, working: 0, waiting: 0, prs: 0 },
          roots: [],
        })
      }
      const list = byRepo.get(key) ?? []
      list.push(place)
      byRepo.set(key, list)
    }
    for (const [key, places] of byRepo) {
      const repo = repos.get(key)!
      // (its branch is its checkout's here, not the pane's: none when that one is detached)
      const first = places[0]!
      const agent: FleetAgent = {
        ...base,
        dir: first.root,
        ...(first.branch ? { branch: first.branch } : {}),
      }
      repo.counts.agents++
      if (agent.status === "working") repo.counts.working++
      if (agent.status === "waiting") repo.counts.waiting++
      const seen = new Set<string>()
      places.forEach((place, i) => {
        if (!repo.roots.includes(place.root)) repo.roots.push(place.root)
        const target = targetOf(repo, place, rowsByUrl)
        if (target === "root") {
          if (i === 0) repo.agents.push(agent)
          return
        }
        if (!target.dirs.some((d) => samePath(d, place.root))) target.dirs.push(place.root)
        const id = "url" in target ? target.url : `branch:${target.name}`
        if (seen.has(id)) return
        seen.add(id)
        ;(i === 0 ? target.agents : target.linked).push(agent)
      })
    }
  }

  // My open PRs with nobody on them, in the repos shown (the lists' order).
  for (const row of mine) {
    if (row.state !== "open" && row.state !== "draft") continue
    const repo = repos.get(row.repo.toLowerCase())
    if (!repo || repo.prs.some((p) => p.url === row.url)) continue
    repo.prs.push({
      url: row.url,
      number: row.number,
      state: row.state,
      row,
      agents: [],
      linked: [],
      dirs: [],
    })
  }
  for (const repo of repos.values()) {
    repo.prs = stacked(repo.prs)
    repo.counts.prs = repo.prs.length
  }
  return [...repos.values()]
}

// As the pull requests dialog (lib/pr-stacks): B is stacked on A when B's base is A's head.
/** A repo's PRs with their base PR, each stack's PRs together: a PR right after its base. */
export function stacked(prs: FleetPr[]): FleetPr[] {
  const rows = prs.flatMap((p) => (p.row ? [p.row] : []))
  const on = new Map<string, FleetPr>()
  for (const p of prs) {
    const b = p.row && baseOf(p.row, rows)
    const node = b && prs.find((q) => q.url === b.url)
    if (node) on.set(p.url, node)
  }
  const out: FleetPr[] = []
  const seen = new Set<string>()
  const walk = (p: FleetPr) => {
    if (seen.has(p.url)) return
    seen.add(p.url)
    const b = on.get(p.url)
    out.push(b ? { ...p, on: { url: b.url, number: b.number } } : p)
    for (const k of prs) if (on.get(k.url) === p) walk(k)
  }
  for (const p of prs) if (!on.has(p.url)) walk(p)
  // (a cycle, A on B and B on A, has no bottom: its PRs as they came, unstacked)
  for (const p of prs) if (!seen.has(p.url)) out.push(p)
  return out
}
