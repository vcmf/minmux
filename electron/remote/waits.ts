// Is a pane's agent showing a dialog right now (a permission prompt, a multiple-choice question)?
// Main's own answer, from hook events as they land, for remote control: a phone's message must
// never press Enter into a dialog. Built apart from the renderer's agent-graph reducer (its known
// flaw: ARCHITECTURE §9a) with its own test matrix (waits.test.ts). Pure.
//
// A wait is opened by:
//   - a permission prompt: Claude's Notification (permission_prompt, or an unknown kind that isn't
//     the idle reminder), a PermissionRequest (Codex, OpenCode, newer Claude)
//   - a question tool starting: PreToolUse of AskUserQuestion / request_user_input / question
// keyed per agent (the pane's session or one of its sub-agents) and per tool call when known.
// It closes when that agent moves on (the call finishes, another call starts, the turn ends, a
// reply is recorded), when the session starts/ends or the user submits a prompt, on the idle
// reminder (the agent is at its prompt), when someone at the desktop answers with a key (see
// localInput), and when the pane closes.

import { agentOf, type AgentEvent, type AgentKind } from "../../src/lib/agent-graph"
import {
  answersSilently,
  isCompactRestart,
  isIdleNotification,
  isQuietNotification,
  QUESTION_TOOLS,
} from "../agents/dialogs"

export interface Wait {
  id: string // this dialog, as a device names it when answering
  agentKind: AgentKind // which agent asked (its dialogs' keys differ)
  agent: string // "" for the pane's session, else the sub-agent's id
  key: string // the tool call (toolKey) when known, else "?"
  kind: "permission" | "question"
  message?: string
  since: number
}

type Ev = Pick<
  AgentEvent,
  | "event"
  | "agent"
  | "paneId"
  | "agentId"
  | "toolKey"
  | "toolName"
  | "message"
  | "notificationType"
  | "source"
>

/** Keys someone at the desktop answers a dialog with. Arrows and typing don't. */
export const isAnswerKey = (data: string): boolean =>
  data === "\r" || data === "\x1b" || data === "\x03" || /^[1-9]$/.test(data)

export class WaitTracker {
  private panes = new Map<string, Wait[]>()
  private running = new Map<string, Set<string>>() // pane + agent → its calls started, not done

  constructor(private readonly now: () => number = Date.now) {}

  /** Any dialog open in the pane. */
  asking(pane: string): boolean {
    return (this.panes.get(pane)?.length ?? 0) > 0
  }

  /** The pane's open dialogs, oldest first (step 4's answer cards). */
  waits(pane: string): Wait[] {
    return this.panes.get(pane) ?? []
  }

  /** Anything open at all: keeps the per-keystroke check to one size test. */
  get any(): boolean {
    return this.panes.size > 0
  }

  apply(ev: Ev): void {
    const pane = ev.paneId
    if (!pane) return
    this.kind = agentOf(ev)
    const agent = ev.agentId ?? ""
    const slot = `${pane}\u0000${agent}`
    switch (ev.event) {
      case "SessionStart":
        if (isCompactRestart(ev)) return // a mid-turn compaction: its dialogs stay
      // falls through
      case "SessionEnd":
      case "UserPromptSubmit":
        if (!ev.agentId) this.clear(pane)
        else this.close(pane, (w) => w.agent === agent)
        this.running.delete(slot)
        return
      case "Stop":
        this.clear(pane) // the turn is over: no dialog of it can still be up
        for (const k of [...this.running.keys()])
          if (k.startsWith(`${pane}\u0000`)) this.running.delete(k)
        return
      case "SubagentStop":
        this.close(pane, (w) => w.agent === agent)
        this.running.delete(slot)
        return
      case "PermissionReplied":
        this.close(pane, (w) => w.agent === agent && w.kind === "permission")
        return
      case "Notification": {
        if (isIdleNotification(ev)) {
          this.clear(pane) // at its prompt, waiting for a message: nothing to answer
          return
        }
        if (isQuietNotification(ev)) return
        // Claude doesn't say which call it asks about: keyless, it stays open until every call
        // this agent has running finished (the one asked about only runs once it's answered).
        this.open(pane, { agent, key: "?", kind: "permission", message: ev.message })
        return
      }
      case "PermissionRequest":
        this.open(pane, { agent, key: ev.toolKey ?? "?", kind: "permission", message: ev.message })
        return
      case "PreToolUse": {
        const key = ev.toolKey ?? "?"
        this.runningOf(slot).add(key)
        // An agent that says nothing when a prompt is answered (Codex): its next call shows it
        // moved on. Others run calls in parallel, so a new call proves nothing there. (The same
        // call: Codex sends PermissionRequest and PreToolUse ~40 ms apart, either order.)
        if (answersSilently(ev.agent))
          this.close(pane, (w) => w.agent === agent && w.key !== key && w.key !== "?")
        if (QUESTION_TOOLS.has(ev.toolName ?? ""))
          this.open(pane, { agent, key, kind: "question", message: ev.message })
        return
      }
      case "PostToolUse":
      case "PostToolUseFailure": {
        const key = ev.toolKey ?? "?"
        const running = this.runningOf(slot)
        running.delete(key)
        // That call ran, so its own dialog was answered. A keyless prompt closes only once none
        // of this agent's calls is still running (one of them is the call it asked about).
        this.close(
          pane,
          (w) => w.agent === agent && (w.key === key || (w.key === "?" && running.size === 0)),
        )
        return
      }
    }
  }

  private runningOf(slot: string): Set<string> {
    let s = this.running.get(slot)
    if (!s) this.running.set(slot, (s = new Set()))
    return s
  }

  // Ctrl+C interrupts: every dialog goes. Esc dismisses the one in front (the oldest). Enter or a
  // digit answers the oldest permission prompt; in a question they only pick (a multi-question or
  // multi-select ask stays up until its tool returns).
  /** Someone at the desktop typed into the pane; true when a dialog closed. */
  localInput(pane: string, data: string): boolean {
    const list = this.panes.get(pane)
    if (!list || !isAnswerKey(data)) return false
    if (data === "\x03") {
      this.clear(pane)
      return true
    }
    const front = data === "\x1b" ? list[0] : list.find((w) => w.kind === "permission")
    if (!front) return false
    this.close(pane, (w) => w === front)
    return true
  }

  /** The pane closed (or its process ended). */
  drop(pane: string): void {
    this.clear(pane)
    for (const k of [...this.running.keys()])
      if (k.startsWith(`${pane}\u0000`)) this.running.delete(k)
  }

  private nextId = 0

  private kind: AgentKind = "claude" // the event being applied's agent (set by apply)

  private open(pane: string, w: Omit<Wait, "since" | "id" | "agentKind">): void {
    const list = this.panes.get(pane) ?? []
    if (list.some((x) => x.agent === w.agent && x.key === w.key && x.kind === w.kind)) return
    const wait = { ...w, agentKind: this.kind, id: `w${++this.nextId}`, since: this.now() }
    this.panes.set(pane, [...list, wait])
  }

  /** A device answered this dialog (the keys are typed): it's closed. */
  answered(pane: string, id: string): void {
    this.close(pane, (w) => w.id === id)
  }

  private close(pane: string, match: (w: Wait) => boolean): void {
    const list = this.panes.get(pane)
    if (!list) return
    const rest = list.filter((w) => !match(w))
    if (rest.length) this.panes.set(pane, rest)
    else this.panes.delete(pane)
  }

  private clear(pane: string): void {
    this.panes.delete(pane)
  }
}
