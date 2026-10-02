// The agent registry: every agent minmux knows, one spec each. Order is rc + display order.

import type { AgentKind } from "../../src/lib/agent-graph"
import { claudeSpec } from "./claude"
import type { AgentAdapter, AgentShell, AgentSpec, SessionRules } from "./types"

export type { AgentAdapter, AgentShell, AgentSpec, SessionRules } from "./types"

export const AGENTS: AgentSpec[] = [claudeSpec]

/** Fresh adapters for this process (they hold per-launch state: settings paths, trackers). */
export const createAdapters = (): AgentAdapter[] => AGENTS.map((a) => a.create())

/** Each agent's rc lines + WSL forwards, in registry order (static: scripts build at load). */
export const AGENT_SHELL: AgentShell[] = AGENTS.map((a) => a.shell)

/** Each agent's resume / lead rules (static: the ledger can exist before adapters install). */
export const AGENT_RULES: Partial<Record<AgentKind, SessionRules>> = Object.fromEntries(
  AGENTS.map((a) => [a.kind, a.rules]),
)

/** Every per-pane env name agents set (a minmux started from a pane must not inherit them). */
export const AGENT_ENV_VARS: string[] = AGENTS.flatMap((a) => a.shell.env)
