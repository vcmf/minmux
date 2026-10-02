// What the UI says and types for each coding agent: names, commands, worktree layouts.
// The renderer side of the agent registry (main's is electron/agents); pure data.

import type { AgentKind } from "./agent-graph"

export interface AgentKindInfo {
  label: string // "Claude"
  command: string // what starts it in a shell
  resumePicker: string // opens the agent's own session picker
  worktreeMarkers: string[] // path parts of worktrees the agent lays out inside a repo
}

export const AGENT_KINDS: Record<AgentKind, AgentKindInfo> = {
  claude: {
    label: "Claude",
    command: "claude",
    resumePicker: "claude --resume",
    worktreeMarkers: ["/.claude/worktrees/"],
  },
  codex: {
    label: "Codex",
    command: "codex",
    resumePicker: "codex resume",
    worktreeMarkers: [],
  },
  opencode: {
    label: "OpenCode",
    command: "opencode",
    resumePicker: "opencode",
    worktreeMarkers: [],
  },
}

/** Agents minmux integrates today (settings switches, the empty board's hint), in order. */
export const AVAILABLE_AGENTS: AgentKind[] = ["claude"]

/** The UI info for an agent (absent = Claude). */
export const agentInfo = (kind?: AgentKind): AgentKindInfo => AGENT_KINDS[kind ?? "claude"]
