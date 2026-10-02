// When to show an agent's "approve minmux's hooks" hint (MULTI_AGENT.md F18). Pure, so the
// rule is tested; terminal-manager applies it.

import type { AgentKind } from "./agent-graph"
import { AGENT_KINDS } from "./agent-kinds"

/** How long after the agent starts without one hook event before the hint shows. */
export const HINT_AFTER_MS = 10_000

/** The agent a launch marker (`OSC 6974;agent;<kind>`) names, or null if not one of ours. */
export function launchedAgent(data: string): AgentKind | null {
  const m = /^agent;([a-z]+)$/.exec(data)
  return m && Object.prototype.hasOwnProperty.call(AGENT_KINDS, m[1]!) ? (m[1] as AgentKind) : null
}

/** After the wait: show the hint? Only if the agent still runs and sent no hook since launch. */
export const hintDue = (o: { launchedAt: number; lastEventAt?: number; running: boolean }) =>
  o.running && !(o.lastEventAt !== undefined && o.lastEventAt >= o.launchedAt)
