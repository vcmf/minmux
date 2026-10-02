// Which agents a pane gets, and which saved sessions may resume, given the per-agent switches.
// Pure (main applies them), so the rules are unit-tested.

import { agentOf, type AgentKind } from "../../src/lib/agent-graph"
import type { LedgerEntry } from "../agent-sessions"
import type { AgentAdapter } from "./types"

/** Env that arms a local pane: every armed, switched-on agent's paths, the drop root and the
 *  pane tag. Empty when none applies (no drop root, nothing armed, all switched off). */
export function agentPaneEnv(
  armed: Pick<AgentAdapter, "kind" | "env">[],
  off: Set<AgentKind>,
  dropRoot: string | null,
  paneId: string,
): Record<string, string> {
  const on = armed.filter((a) => !off.has(a.kind))
  if (!dropRoot || on.length === 0) return {}
  const env: Record<string, string> = {}
  for (const a of on) Object.assign(env, a.env())
  return { ...env, MINMUX_AGENT_EVENTS: dropRoot, MINMUX_PANE_ID: paneId }
}

/** Restored panes split by the switches: those that may resume, and those whose saved session
 *  belongs to a switched-off agent (dropped: the pane opens plain, nothing stale waits). */
export function resumablePanes(
  paneIds: string[],
  entryOf: (paneId: string) => LedgerEntry | undefined,
  off: Set<AgentKind>,
): { resume: string[]; drop: string[] } {
  const resume: string[] = []
  const drop: string[] = []
  for (const id of paneIds) {
    const e = entryOf(id)
    if (e && off.has(agentOf(e))) drop.push(id)
    else resume.push(id)
  }
  return { resume, drop }
}
