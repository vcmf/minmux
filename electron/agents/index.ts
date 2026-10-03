// The agent registry: every agent minmux knows, one spec each. Order is rc + display order.

import type { AgentKind } from "../../src/lib/agent-graph"
import { claudeSpec } from "./claude"
import { codexSpec } from "./codex"
import { opencodeSpec } from "./opencode"
import type { AdapterContext, AgentAdapter, AgentShell, AgentSpec, SessionRules } from "./types"

export type { AgentAdapter, AgentShell, AgentSpec, SessionRules } from "./types"

export const AGENTS: AgentSpec[] = [claudeSpec, codexSpec, opencodeSpec]

/** Fresh adapters for this process (per-launch state: settings paths, trackers), for the agents
 *  integrated on this platform. */
export const createAdapters = (platform = process.platform, ctx?: AdapterContext): AgentAdapter[] =>
  AGENTS.filter((a) => platform !== "win32" || a.windows !== false).map((a) => a.create(ctx))

/** Each agent's rc lines + WSL forwards, in registry order (static: scripts build at load). */
export const AGENT_SHELL: AgentShell[] = AGENTS.map((a) => a.shell)

/** Each agent's resume / lead rules (static: the ledger can exist before adapters install). */
export const AGENT_RULES: Partial<Record<AgentKind, SessionRules>> = Object.fromEntries(
  AGENTS.map((a) => [a.kind, a.rules]),
)

/** Every per-pane env name agents set (a minmux started from a pane must not inherit them). */
export const AGENT_ENV_VARS: string[] = AGENTS.flatMap((a) => a.shell.env)

/** The user's vars agents add to, with how to take a parent minmux's part out of each. */
export const AGENT_MERGED_VARS: [string, (value: string) => string | undefined][] = AGENTS.flatMap(
  (a) => Object.entries(a.shell.merged ?? {}),
)
