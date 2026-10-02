// What one coding agent plugs into the main process (docs/design/MULTI_AGENT.md §4.2). Each
// agent is one spec + adapter in this folder; nothing agent-specific in main lives elsewhere.

import type { AgentEvent, AgentKind } from "../../src/lib/agent-graph"
import type { DropNormalizer } from "../agent-hooks"
import type { LedgerEntry } from "../agent-sessions"
import type { ResolvePath } from "../agent-tokens"

export type { ResolvePath }

/** The rules the resume ledger applies to one agent's sessions. */
export interface SessionRules {
  /** The command that resumes this entry's session; null if its id can't be trusted. */
  resumeCommand(e: LedgerEntry, allowBypass: boolean): string | null
  /** Does `cwd` belong to the session filed at `transcriptPath`? undefined = can't tell. */
  cwdFits(cwd: string | undefined, transcriptPath: string | undefined): boolean | undefined
  /** A new session while one of this agent's leads the pane: a switch (vs a background agent)? */
  isSwitch(ev: AgentEvent, lead: LedgerEntry): boolean
}

/** The rc lines our zsh/bash integration adds for an agent, and its per-pane env. */
export interface AgentShell {
  zsh: string[]
  bash: string[]
  env: string[] // every per-pane env name the agent's adapter sets (scrubbed from children)
  wslenv: string[] // the ones WSL must forward, with their WSLENV flags
}

export interface AgentAdapter {
  kind: AgentKind
  /** Write this launch's files into the config dir (hook settings…); throws on failure. */
  install(cfgDir: string): void
  /** Env that arms the agent in one local pane (after `install`). */
  env(): Record<string, string>
  /** A raw drop from this agent's folder → an event (or null). Never throws on bad input. */
  normalize: DropNormalizer
  /** Token totals for a batch of this agent's events, read off the hot path. */
  usage?(batch: AgentEvent[], resolve: ResolvePath): Promise<AgentEvent[]>
  /** The lead session's name/colour live in its transcript (Claude's /color, /rename). */
  transcriptMeta?: boolean
}

/** One agent's registration: static parts (rc, env, rules) + its per-launch adapter factory. */
export interface AgentSpec {
  kind: AgentKind
  windows?: false // not integrated on Windows (nor so its WSL panes) yet; mirrors agent-kinds
  shell: AgentShell
  rules: SessionRules
  create(): AgentAdapter
}
