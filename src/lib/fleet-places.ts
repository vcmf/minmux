// Where each agent session works, for the fleet graph (docs/design/FLEET_GRAPH.md, "Data"): a
// ledger kept per session, one slot per checkout the sidebar looks up (`edits`, `in`, `from`).
// A slot changes only when its lookup has answered for the session's current folder; while an
// answer is on the way the slot keeps what it had, so the graph never shows a half-answered
// mix. Slots belong to a session: a new one in the same pane starts empty. Pure.
import { paneLeads, type AgentGraph, type AgentNode } from "./agent-graph"
import { agentWorkDirs, gitKey, inGitFor, samePath, worksElsewhere } from "./agent-dirs"
import type { PaneWork } from "./agent-work"
import type { PaneGitInfo, PrInfo } from "./pane-git"
import type { Session } from "../types"

/** A checkout an agent works in: its root, branch and PR (when known). */
export interface Place {
  root: string
  branch?: string
  pr?: PrInfo
}

export const SLOTS = ["edit", "in", "from"] as const // (the order that places an agent)
export type Slot = (typeof SLOTS)[number]

/** Per session id: its checkouts by slot. */
export type PlaceLedger = Record<string, Partial<Record<Slot, Place>>>

export interface PlacesInput {
  agents: AgentGraph
  paneGit: Record<string, PaneGitInfo>
  sessions: Record<string, Pick<Session, "cwd">>
  paneWork: Record<string, PaneWork>
}

const placeOf = (g: PaneGitInfo): Place | null =>
  g.root
    ? { root: g.root, ...(g.branch ? { branch: g.branch } : {}), ...(g.pr ? { pr: g.pr } : {}) }
    : null

// A Place, null (answered: none there), or undefined (not answered for its folder yet).
/** What each lookup says now about a pane's lead session. */
export function answers(
  input: PlacesInput,
  n: AgentNode,
  paneId: string,
): Record<Slot, Place | null | undefined> {
  const { agents: graph, paneGit, sessions, paneWork } = input
  // `edits`: as the sidebar's line, only with a branch or a PR (else it's one of the `+N`).
  const work = paneWork[paneId]?.session === n.sessionId ? paneWork[paneId] : undefined
  const shown = work?.shown
  const edit = paneGit[gitKey(paneId, "edit")]
  const editAt = !shown
    ? null
    : edit?.forCwd && samePath(edit.forCwd, shown)
      ? edit.branch || edit.pr
        ? placeOf(edit)
        : null
      : undefined
  // `in`: only while it works elsewhere than the shell's checkout.
  const dir = agentWorkDirs(graph)[paneId]
  const shellCwd = sessions[paneId]?.cwd
  const shell = paneGit[paneId]
  const inGit = paneGit[gitKey(paneId, "in")]
  const inKnown = dir?.cwd ? inGitFor(inGit, dir.cwd, dir.agent) : undefined
  const inAt = !dir?.cwd
    ? null
    : !inKnown
      ? undefined
      : worksElsewhere(shellCwd, dir.cwd, shell, inGit, dir.agent)
        ? placeOf(inKnown)
        : null
  // `from`: the shell's, once answered for its folder.
  const fromAt = !shellCwd
    ? null
    : shell?.forCwd && samePath(shell.forCwd, shellCwd)
      ? placeOf(shell)
      : undefined
  return { edit: editAt, in: inAt, from: fromAt }
}

const samePlace = (a: Place | undefined, b: Place | undefined) =>
  a === b ||
  (!!a &&
    !!b &&
    a.root === b.root &&
    a.branch === b.branch &&
    a.pr?.url === b.pr?.url &&
    a.pr?.state === b.pr?.state &&
    a.pr?.number === b.pr?.number)

/** The ledger after this round of answers: the same reference when nothing changed. */
export function nextPlaces(prev: PlaceLedger, input: PlacesInput): PlaceLedger {
  const next: PlaceLedger = {}
  let changed = false
  for (const [paneId, n] of Object.entries(paneLeads(input.agents))) {
    if (!input.sessions[paneId]) continue
    const old = prev[n.sessionId] ?? {}
    const now = answers(input, n, paneId)
    const slots: Partial<Record<Slot, Place>> = {}
    for (const k of SLOTS) {
      const a = now[k]
      const v = a === undefined ? old[k] : (a ?? undefined) // (on the way: what it had)
      if (v) slots[k] = samePlace(v, old[k]) ? old[k]! : v
      if (slots[k] !== old[k]) changed = true
    }
    next[n.sessionId] = slots
    if (!(n.sessionId in prev)) changed = true
  }
  if (!changed && Object.keys(prev).length === Object.keys(next).length) return prev
  return next
}
