// Is a pane's agent between turns (stopped, at its prompt)? Remote control sends a phone's message
// only then: a dialog (a permission prompt, a question) can only be up during a turn, so a
// message's Enter can't answer one. Positive evidence only: the lead session's own Stop, idle
// reminder or fresh start; anything else from it means a turn is on. Pure; main feeds it the
// lead's hook events (nested and background sessions in the pane are left out by the caller).

import type { AgentEvent } from "../../src/lib/agent-graph"
import { isIdleNotification } from "../agents/dialogs"

export type Turn = "between" | "working"

type Ev = Pick<AgentEvent, "event" | "paneId" | "agentId" | "notificationType" | "message">

export class TurnTracker {
  private panes = new Map<string, Turn>()

  /** "between" only after the lead said so; unknown (no event since launch) counts as working. */
  turn(pane: string): Turn {
    return this.panes.get(pane) ?? "working"
  }

  apply(ev: Ev): void {
    const pane = ev.paneId
    if (!pane) return
    const root = !ev.agentId
    if (root && (ev.event === "Stop" || ev.event === "SessionStart")) {
      this.panes.set(pane, "between")
      return
    }
    if (root && ev.event === "Notification" && isIdleNotification(ev)) {
      this.panes.set(pane, "between")
      return
    }
    if (root && ev.event === "SessionEnd") {
      this.panes.delete(pane)
      return
    }
    // Anything else from the session or its sub-agents happens inside a turn.
    this.panes.set(pane, "working")
  }

  drop(pane: string): void {
    this.panes.delete(pane)
  }
}
