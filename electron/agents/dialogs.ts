// What the agents' dialogs look like in their hook events (agent specifics stay in
// electron/agents): the tools that ask the user a question, and Claude's notifications that
// aren't a dialog. Used by remote control's wait tracker (electron/remote/waits.ts).
import type { AgentEvent } from "../../src/lib/agent-graph"

/** Tools whose call shows a question with options (Claude, Codex, OpenCode). */
export const QUESTION_TOOLS = new Set(["AskUserQuestion", "request_user_input", "question"])

const IDLE = /waiting for your input/i

/** The agent is at its prompt waiting for a message (Claude's idle reminder): no dialog. */
export const isIdleNotification = (ev: Pick<AgentEvent, "notificationType" | "message">) =>
  ev.notificationType === "idle_prompt" || (!ev.notificationType && IDLE.test(ev.message ?? ""))

/** A notification that shows nothing to answer (Claude's auth_success). */
export const isQuietNotification = (ev: Pick<AgentEvent, "notificationType">) =>
  ev.notificationType === "auth_success"

// Claude and OpenCode report an answer (the call runs, or PermissionReplied); Codex doesn't.
/** Agents whose next tool call is the only sign a permission prompt was answered. */
export const answersSilently = (agent: AgentEvent["agent"]) => agent === "codex"

/** A session started again by compaction (Claude's auto-compact mid-turn): its turn goes on. */
export const isCompactRestart = (ev: Pick<AgentEvent, "event" | "source">) =>
  ev.event === "SessionStart" && ev.source === "compact"
