// The per-agent on/off switches (`settings.agents`): shared by the renderer's schema and main,
// which reads them at spawn without pulling in the rest of the settings (themes…).

import type { AgentKind } from "../lib/agent-graph"
import { AGENT_KINDS } from "../lib/agent-kinds"

export type AgentSwitches = Record<AgentKind, { enabled: boolean }>

const KINDS = Object.keys(AGENT_KINDS) as AgentKind[]

/** Every known agent switched on. */
export const defaultAgentSwitches = (): AgentSwitches =>
  Object.fromEntries(KINDS.map((k) => [k, { enabled: true }])) as AgentSwitches

const asObject = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" ? (v as Record<string, unknown>) : {}

/** Switches from arbitrary input: known agents only, booleans only, the rest defaults. */
export function mergeAgentSwitches(v: unknown): AgentSwitches {
  const o = asObject(v)
  const out = defaultAgentSwitches()
  for (const k of KINDS) {
    const e = asObject(o[k]).enabled
    if (typeof e === "boolean") out[k] = { enabled: e }
  }
  return out
}

/** The agents a set of switches turns off. */
export const disabledAgentsIn = (s: AgentSwitches): Set<AgentKind> =>
  new Set(KINDS.filter((k) => !s[k].enabled))
