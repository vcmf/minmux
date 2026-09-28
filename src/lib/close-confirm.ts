// When closing needs an "are you sure?", and what the dialog says. Pure — the rules are
// product decisions, so they're unit-tested:
//   · a session (tab) with more than one terminal → always ask; a single one → ask if running
//   · a terminal (sidebar row, its tab in a pane) → ask if it's running
//   · a pane holding several terminals → always ask (unchanged)
// "Running" = a command in progress (OSC 133 C..D) or a live Claude in that terminal.

import type { PaneNode } from "../types"
import { allSessionIds, findPaneById } from "./pane-tree"

/** A close awaiting the confirm dialog. */
export type CloseConfirm =
  | { kind: "pane"; tabId: string; paneId: string; count: number }
  | { kind: "tab"; tabId: string; title: string; count: number; claude: number }
  | { kind: "terminal"; tabId: string; sessionId: string; title: string; claude: boolean }

/** A terminal's state, as far as closing it is concerned. */
export interface TerminalState {
  id: string
  running: boolean // a command in progress (OSC 133)
  claude: boolean // a live Claude session in it
}

const busy = (t: TerminalState) => t.running || t.claude

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
  const claude = terminals.filter((t) => t.claude).length
  return { kind: "tab", tabId, title, count: terminals.length, claude }
}

/** Closing one terminal: the confirm to show (only while it's running), or null. */
export function terminalCloseConfirm(
  tabId: string,
  title: string,
  t: TerminalState,
): CloseConfirm | null {
  if (!busy(t)) return null
  return { kind: "terminal", tabId, sessionId: t.id, title, claude: t.claude }
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`

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
            ? c.claude
              ? "Claude is running in its terminal. Closing it stops Claude and the shell."
              : "Its terminal will close and whatever runs in it stops."
            : `${plural(c.count, "terminal")} will close and whatever runs in them stops.` +
              (c.claude ? ` ${c.claude === 1 ? "1 is" : `${c.claude} are`} running Claude.` : ""),
        action: "Close session",
      }
    case "terminal":
      return {
        title: `Close "${c.title}"?`,
        body: c.claude
          ? "Claude is running in this terminal. Closing it stops Claude and the shell."
          : "A command is still running in this terminal. Closing it stops it.",
        action: "Close terminal",
      }
  }
}
