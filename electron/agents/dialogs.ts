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

/** Agents that send nothing when a permission prompt is answered (Codex): their next tool call is
 *  the sign. Claude and OpenCode report it (the call runs, or PermissionReplied). */
export const answersSilently = (agent: AgentEvent["agent"]) => agent === "codex"
