// What the UI says and types for each coding agent: names, commands, worktree layouts.
// The renderer side of the agent registry (main's is electron/agents); pure data.

import type { AgentKind } from "./agent-graph"

export interface AgentKindInfo {
  label: string // "Claude"
  command: string // what starts it in a shell
  resumePicker: string // opens the agent's own session picker
  worktreeMarkers: string[] // path parts of worktrees the agent lays out inside a repo
  windows?: false // not integrated on Windows (nor its WSL panes) yet
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
    windows: false, // hook quoting there is unverified (MULTI_AGENT.md S1-e)
  },
  opencode: {
    label: "OpenCode",
    command: "opencode",
    resumePicker: "opencode",
    worktreeMarkers: [],
  },
}

/** Agents minmux integrates today (settings switches, the empty board's hint), in order. */
export const AVAILABLE_AGENTS: AgentKind[] = ["claude", "codex"]

/** The agents integrated on this platform (`process.platform`-style; "" = not known yet, so
 *  only the agents integrated everywhere). */
export const agentsOn = (platform: string): AgentKind[] =>
  AVAILABLE_AGENTS.filter(
    (k) => (platform !== "win32" && platform !== "") || AGENT_KINDS[k].windows !== false,
  )

/** The UI info for an agent (absent = Claude). */
export const agentInfo = (kind?: AgentKind): AgentKindInfo => AGENT_KINDS[kind ?? "claude"]
