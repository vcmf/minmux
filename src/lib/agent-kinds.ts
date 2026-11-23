// What the UI says and types for each coding agent: names, commands, worktree layouts.
// The renderer side of the agent registry (main's is electron/agents); pure data.

import type { AgentKind } from "./agent-graph"

export interface AgentKindInfo {
  label: string // "Claude"
  command: string // what starts it in a shell (and the binary the new-tab menu looks for)
  installPaths?: string[] // where else it may be installed, off PATH (relative to home)
  resumePicker: string // opens the agent's own session picker
  resumePickerLabel?: string // its button, when that isn't a picker of its own ("Pick a session…")
  worktreeMarkers: string[] // path parts of worktrees the agent lays out inside a repo
  windows?: false // not integrated on Windows (nor its WSL panes) yet
  confirmsOnPrompt?: true // its session starts (and so a resume confirms) with the first message
  hookApproval?: true // minmux's hooks need the user's approval in the agent (Codex)
  history?: true // the Sessions tab lists its sessions (a reader in electron/agents/history-index)
  color?: { dark: string; light: string } // its icon's colour (none: the text colour)
}

export const AGENT_KINDS: Record<AgentKind, AgentKindInfo> = {
  claude: {
    label: "Claude",
    command: "claude",
    // The old local installer: a shell alias to this file, not a PATH entry.
    installPaths: [".claude/local/claude"],
    resumePicker: "claude --resume",
    worktreeMarkers: ["/.claude/worktrees/"],
    history: true,
    color: { dark: "#d97757", light: "#c15f3c" }, // terracotta
  },
  codex: {
    label: "Codex",
    command: "codex",
    resumePicker: "codex resume",
    worktreeMarkers: [],
    windows: false, // hook quoting there is unverified (MULTI_AGENT.md S1-e)
    confirmsOnPrompt: true, // SessionStart fires with the first prompt (S1-f)
    hookApproval: true, // its hooks run once the user trusts them (/hooks)
    history: true,
    color: { dark: "#6aa2f8", light: "#2f6bd0" },
  },
  opencode: {
    label: "OpenCode",
    command: "opencode",
    resumePicker: "opencode",
    resumePickerLabel: "Open OpenCode (/sessions)", // no CLI picker: /sessions in the TUI
    // At latest: its plugin starts a resumed session at once, else with its first prompt.
    confirmsOnPrompt: true,
    worktreeMarkers: [],
    windows: false, // its plugin's file: URL and WSL forwarding are unverified there
    history: true,
  },
}

/** Agents minmux integrates today (settings switches, the empty board's hint), in order. */
export const AVAILABLE_AGENTS: AgentKind[] = ["claude", "codex", "opencode"]

/** The agents integrated on this platform (`process.platform`-style; "" = not known yet, so
 *  only the agents integrated everywhere). */
export const agentsOn = (platform: string): AgentKind[] =>
  AVAILABLE_AGENTS.filter(
    (k) => (platform !== "win32" && platform !== "") || AGENT_KINDS[k].windows !== false,
  )

/** An agent's icon colour for this scheme (undefined: the text colour). */
export const agentColor = (kind: AgentKind, scheme: "dark" | "light"): string | undefined =>
  AGENT_KINDS[kind].color?.[scheme]

/** The UI info for an agent (absent = Claude). */
export const agentInfo = (kind?: AgentKind): AgentKindInfo => AGENT_KINDS[kind ?? "claude"]
