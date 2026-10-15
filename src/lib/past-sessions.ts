// Past agent sessions for the Sessions tab (docs/design/AGENT_SESSIONS.md): the row shape main
// sends, and the pure rules both sides share (labels, what counts as a prompt, filters, order).

import type { AgentGraph, AgentKind } from "./agent-graph"
import type { ResumeState } from "./resume"
import { isInside, samePath } from "./agent-dirs"

/** One session an agent keeps on disk. */
export interface PastSession {
  agent: AgentKind
  sessionId: string
  name?: string // the user's rename, else the agent's own title
  firstPrompt?: string // fallback label: one line, ≤ PROMPT_MAX
  cwd?: string // where it ran (resume needs it)
  updatedAt: number // ms
  cwdGone?: boolean // that folder no longer exists
}

/** The list main answers with; `failed` names the agents whose sessions couldn't be read. */
export interface PastSessionsResult {
  sessions: PastSession[]
  failed: AgentKind[]
}

export const PROMPT_MAX = 200
export const LIST_MAX = 500 // newest first; older ones are cut

/** Text on one line, trimmed and capped (undefined when nothing is left). */
export function oneLine(text: string, max = PROMPT_MAX): string | undefined {
  const t = text.replace(/\s+/g, " ").trim()
  if (!t) return undefined
  return t.length > max ? `${t.slice(0, max - 1)}…` : t
}

/** Is this user-turn text something the user typed, not one of the agent's own `injected`
 *  blocks (each reader knows its agent's)? A prompt to name a session by. */
export const isTypedPrompt = (text: string, injected: RegExp): boolean =>
  !!text.trim() && !injected.test(text.trim())

/** Written this recently, a session may be running where minmux can't see it (another
 *  terminal, hooks off): resuming it then takes a second click. */
export const BUSY_MS = 2 * 60_000

/** The row's label: the session's name, else its first prompt. */
export const pastLabel = (s: PastSession): string => s.name || s.firstPrompt || "Untitled session"

/** Newest first, one row per agent session, at most `max`. */
export function mergePast(lists: PastSession[][], max = LIST_MAX): PastSession[] {
  const seen = new Map<string, PastSession>()
  for (const s of lists.flat()) {
    const key = `${s.agent}:${s.sessionId}`
    const had = seen.get(key)
    if (!had || s.updatedAt > had.updatedAt) seen.set(key, s)
  }
  return [...seen.values()].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, max)
}

/** The rows to show: these agents only, and with `here`, only sessions in that folder or below. */
export function filterPast(
  list: PastSession[],
  agents: ReadonlySet<AgentKind>,
  here?: string,
): PastSession[] {
  return list.filter(
    (s) =>
      agents.has(s.agent) &&
      (!here || (!!s.cwd && (samePath(s.cwd, here) || isInside(s.cwd, here)))),
  )
}

/** "2m", "3h", "5d", "4w", "1y": how long ago, for a row. */
export function ago(ms: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ms) / 1000))
  if (s < 60) return "now"
  const steps: [number, string][] = [
    [60, "m"],
    [24, "h"],
    [7, "d"],
    [52, "w"],
  ]
  let v = s / 60
  for (const [n, unit] of steps) {
    if (v < n) return `${Math.floor(v)}${unit}`
    v /= n
  }
  return `${Math.floor(v)}y`
}

// A resume still on its way (typed or about to be, not yet confirmed or failed), or typed into
// a shell that can't confirm it ("sent"): that terminal has the session.
const RESUMING = new Set<ResumeState["phase"]>(["pending", "offer", "resuming", "waiting", "sent"])

/** The terminal this session runs in now (or is being resumed in), if any: a click goes there. */
export const paneOf = (
  s: Pick<PastSession, "agent" | "sessionId">,
  graph: AgentGraph,
  terminals: Record<string, unknown>,
  resume: Record<string, ResumeState>,
): string | undefined => panesFor([s], graph, terminals, resume)[0] || undefined

/** Per row, the terminal it runs in ("" = none): one pass over the graph and the resumes. */
export function panesFor(
  rows: Pick<PastSession, "agent" | "sessionId">[],
  graph: AgentGraph,
  terminals: Record<string, unknown>,
  resume: Record<string, ResumeState>,
): string[] {
  const resuming = new Map<string, string>()
  for (const [id, r] of Object.entries(resume))
    if (RESUMING.has(r.phase) && id in terminals) resuming.set(r.plan.sessionId, id)
  return rows.map((s) => {
    const node = graph.nodes[`root:${s.sessionId}`]
    if (node?.paneId && node.agent === s.agent && node.paneId in terminals) return node.paneId
    return resuming.get(s.sessionId) ?? ""
  })
}
