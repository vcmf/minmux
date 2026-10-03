// When closing needs an "are you sure?", and what the dialog says. Pure — the rules are
// product decisions, so they're unit-tested:
//   · a session (tab) with more than one terminal → always ask; a single one → ask if running
//   · a terminal (sidebar row, its tab in a pane) → ask if it's running
//   · a pane holding several terminals → always ask (unchanged)
// "Running" = a command in progress (OSC 133 C..D) or a live agent (Claude, …) in that terminal.

import type { PaneNode } from "../types"
import type { AgentKind } from "./agent-graph"
import { agentInfo } from "./agent-kinds"
import { allSessionIds, findPaneById } from "./pane-tree"

/** A close awaiting the confirm dialog. */
export type CloseConfirm =
  | { kind: "pane"; tabId: string; paneId: string; count: number }
  | { kind: "tab"; tabId: string; title: string; count: number; agents: AgentKind[] }
  | { kind: "terminal"; tabId: string; sessionId: string; title: string; agent?: AgentKind }

/** A terminal's state, as far as closing it is concerned. */
export interface TerminalState {
  id: string
  running: boolean // a command in progress (OSC 133)
  agent?: AgentKind // the agent whose live session leads it
}

const busy = (t: TerminalState) => t.running || !!t.agent

/** Is the pending close's target still there (in `tabs`)? A close from elsewhere can beat it. */
export function confirmStillValid(
  c: CloseConfirm,
  tabs: { id: string; root: PaneNode }[],
): boolean {
  const tab = tabs.find((t) => t.id === c.tabId)
  if (!tab) return false
  if (c.kind === "terminal") return allSessionIds(tab.root).includes(c.sessionId)
  if (c.kind === "pane") return !!findPaneById(tab.root, c.paneId)
  return true
}

/** Closing a session: the confirm to show, or null to close right away. */
export function tabCloseConfirm(
  tabId: string,
  title: string,
  terminals: TerminalState[],
): CloseConfirm | null {
  if (terminals.length <= 1 && !terminals.some(busy)) return null
  const agents = terminals.flatMap((t) => (t.agent ? [t.agent] : []))
  return { kind: "tab", tabId, title, count: terminals.length, agents }
}

/** Closing one terminal: the confirm to show (only while it's running), or null. */
export function terminalCloseConfirm(
  tabId: string,
  title: string,
  t: TerminalState,
): CloseConfirm | null {
  if (!busy(t)) return null
  return { kind: "terminal", tabId, sessionId: t.id, title, agent: t.agent }
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`

/** "Claude" when every running agent is Claude, "agents" when they differ. */
const agentsLabel = (agents: AgentKind[]) =>
  agents.every((a) => a === agents[0]) ? agentInfo(agents[0]).label : "agents"

/** The sentence for a terminal a live agent runs in. */
const agentRunning = (agent: AgentKind, where: string) => {
  const name = agentInfo(agent).label
  return `${name} is running in ${where}. Closing it stops ${name} and the shell.`
}

/** The dialog's heading, body and confirm button for a pending close. */
export function closeConfirmText(c: CloseConfirm): { title: string; body: string; action: string } {
  switch (c.kind) {
    case "pane":
      return {
        title: `Close pane with ${c.count} terminals?`,
        body: "Every terminal in this pane will be closed and its running processes stopped.",
        action: "Close pane",
      }
    case "tab":
      return {
        title: `Close "${c.title}"?`,
        body:
          c.count === 1
            ? c.agents[0]
              ? agentRunning(c.agents[0], "its terminal")
              : "Its terminal will close and whatever runs in it stops."
            : `${plural(c.count, "terminal")} will close and whatever runs in them stops.` +
              (c.agents.length
                ? ` ${c.agents.length === 1 ? "1 is" : `${c.agents.length} are`} running ${agentsLabel(c.agents)}.`
                : ""),
        action: "Close session",
      }
    case "terminal":
      return {
        title: `Close "${c.title}"?`,
        body: c.agent
          ? agentRunning(c.agent, "this terminal")
          : "A command is still running in this terminal. Closing it stops it.",
        action: "Close terminal",
      }
  }
}
