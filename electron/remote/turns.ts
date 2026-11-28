// Is a pane's agent between turns (stopped, at its prompt)? Remote control sends a phone's message
// only then: a dialog (a permission prompt, a question) can only be up during a turn, so a
// message's Enter can't answer one. Positive evidence only: the lead session's Stop, idle reminder
// or a fresh start, with none of its sub-agents still running. Only events that start or carry on a
// turn end that; others (a title, a file change, token counts) say nothing. Pure; main feeds it the
// lead's hook events (nested and background sessions in the pane are left out by the caller).

import type { AgentEvent } from "../../src/lib/agent-graph"
import { isCompactRestart, isIdleNotification, isQuietNotification } from "../agents/dialogs"

export type Turn = "between" | "working"

type Ev = Pick<
  AgentEvent,
  "event" | "paneId" | "agentId" | "notificationType" | "message" | "source"
>

// Events that happen inside a turn (from the session or a sub-agent).
const IN_TURN = new Set([
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "PermissionRequest",
  "PermissionReplied",
  "SubagentStart",
])

interface PaneTurn {
  stopped: boolean // the lead's own turn is over
  subs: Set<string> // sub-agents still running (they can ask too)
  startedAt?: number // set by started(): a turn assumed on until its hook confirms (or expires)
}

// An Enter that started nothing (a built-in slash command, a menu pick, an empty prompt) fires no
// hook: the assumed turn ends after this long without one.
export const ASSUMED_TURN_MS = 5000

export class TurnTracker {
  private panes = new Map<string, PaneTurn>()

  constructor(private readonly now: () => number = Date.now) {}

  /** "between" only after the lead said so; unknown (no event since launch) counts as working. */
  turn(pane: string): Turn {
    const t = this.panes.get(pane)
    if (t?.startedAt !== undefined && this.now() - t.startedAt >= ASSUMED_TURN_MS) {
      t.startedAt = undefined
      t.stopped = true // nothing confirmed it: back to between
    }
    return t && t.stopped && t.subs.size === 0 ? "between" : "working"
  }

  apply(ev: Ev): void {
    const pane = ev.paneId
    if (!pane) return
    const t = this.panes.get(pane) ?? { stopped: false, subs: new Set<string>() }
    this.panes.set(pane, t)
    const root = !ev.agentId
    switch (ev.event) {
      case "SessionStart":
        // A compaction mid-turn starts the session again: the turn goes on.
        if (root && !isCompactRestart(ev)) {
          t.stopped = true
          t.subs.clear()
          t.startedAt = undefined
        }
        return
      case "SessionEnd":
        if (root) this.panes.delete(pane)
        return
      case "Stop":
        if (root) {
          t.stopped = true
          t.startedAt = undefined
        }
        return
      case "SubagentStop":
        if (ev.agentId) t.subs.delete(ev.agentId)
        return
      case "Notification":
        if (isIdleNotification(ev)) {
          // At its prompt: nothing of an earlier turn runs on (an interrupted sub-agent may
          // never send its SubagentStop).
          if (root) {
            t.stopped = true
            t.subs.clear()
            t.startedAt = undefined
          }
        } else if (!isQuietNotification(ev)) this.inTurn(t, ev)
        return
      default:
        if (IN_TURN.has(ev.event)) this.inTurn(t, ev)
    }
  }

  /** A message was just submitted to the pane: a turn is on, ahead of its hook. */
  started(pane: string): void {
    const t = this.panes.get(pane)
    if (!t || !t.stopped) return // not known to be between: nothing to assume
    t.stopped = false
    t.startedAt = this.now()
  }

  drop(pane: string): void {
    this.panes.delete(pane)
  }

  // Only events that decide the turn confirm an assumed start; others (a file change, a title)
  // leave its expiry running.
  private inTurn(t: PaneTurn, ev: Ev): void {
    t.startedAt = undefined
    if (ev.agentId) t.subs.add(ev.agentId)
    else {
      t.stopped = false
      // A new prompt: sub-agents of an earlier, interrupted turn are gone.
      if (ev.event === "UserPromptSubmit") t.subs.clear()
    }
  }
}
