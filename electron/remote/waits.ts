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
// reminder (the agent is at its prompt), when someone at the desktop answers with a key
// (Enter, Esc, a digit, y/n), and when the pane closes.

import type { AgentEvent } from "../../src/lib/agent-graph"

export const QUESTION_TOOLS = new Set(["AskUserQuestion", "request_user_input", "question"])
const IDLE = /waiting for your input/i

export interface Wait {
  agent: string // "" for the pane's session, else the sub-agent's id
  key: string // the tool call (toolKey) when known, else "?"
  kind: "permission" | "question"
  message?: string
  since: number
}

type Ev = Pick<
  AgentEvent,
  "event" | "paneId" | "agentId" | "toolKey" | "toolName" | "message" | "notificationType"
>

/** Keys someone at the desktop answers a dialog with. Arrows and typing don't. */
export const isAnswerKey = (data: string): boolean =>
  data === "\r" || data === "\x1b" || /^[0-9yYnN]$/.test(data)

export class WaitTracker {
  private panes = new Map<string, Wait[]>()
  private lastPre = new Map<string, string>() // pane + agent → its latest PreToolUse toolKey

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
    const agent = ev.agentId ?? ""
    const slot = `${pane}\u0000${agent}`
    switch (ev.event) {
      case "SessionStart":
      case "SessionEnd":
      case "UserPromptSubmit":
        if (!ev.agentId) this.clear(pane)
        else this.close(pane, (w) => w.agent === agent)
        return
      case "Stop":
        this.clear(pane) // the turn is over: no dialog of it can still be up
        return
      case "SubagentStop":
        this.close(pane, (w) => w.agent === agent)
        return
      case "PermissionReplied":
        this.close(pane, (w) => w.agent === agent && w.kind === "permission")
        return
      case "Notification": {
        const t = ev.notificationType
        if (t === "idle_prompt" || (!t && IDLE.test(ev.message ?? ""))) {
          this.clear(pane) // at its prompt, waiting for a message: nothing to answer
          return
        }
        if (t === "auth_success") return
        this.open(pane, {
          agent,
          key: this.lastPre.get(slot) ?? "?",
          kind: "permission",
          message: ev.message,
        })
        return
      }
      case "PermissionRequest":
        this.open(pane, { agent, key: ev.toolKey ?? "?", kind: "permission", message: ev.message })
        return
      case "PreToolUse": {
        const key = ev.toolKey ?? "?"
        // Another call of this agent started: its earlier dialogs were answered. (The same call:
        // Codex sends PermissionRequest and PreToolUse ~40 ms apart, either order.)
        this.close(pane, (w) => w.agent === agent && w.key !== key && w.key !== "?")
        this.lastPre.set(slot, key)
        if (QUESTION_TOOLS.has(ev.toolName ?? ""))
          this.open(pane, { agent, key, kind: "question", message: ev.message })
        return
      }
      case "PostToolUse": {
        const key = ev.toolKey ?? "?"
        // That call ran (so its dialog was answered); a keyless prompt of this agent too.
        this.close(pane, (w) => w.agent === agent && (w.key === key || w.key === "?"))
        return
      }
    }
  }

  /** Someone at the desktop typed into the pane: an answer key closes its dialogs. */
  localInput(pane: string, data: string): void {
    if (this.panes.has(pane) && isAnswerKey(data)) this.clear(pane)
  }

  /** The pane closed (or its process ended). */
  drop(pane: string): void {
    this.clear(pane)
    for (const k of [...this.lastPre.keys()])
      if (k.startsWith(`${pane}\u0000`)) this.lastPre.delete(k)
  }

  private open(pane: string, w: Omit<Wait, "since">): void {
    const list = this.panes.get(pane) ?? []
    if (list.some((x) => x.agent === w.agent && x.key === w.key && x.kind === w.kind)) return
    this.panes.set(pane, [...list, { ...w, since: this.now() }])
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
