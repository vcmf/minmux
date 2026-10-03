import { useEffect, useState } from "react"
import { X } from "@phosphor-icons/react"
import { useStore } from "../store"
import { ipc } from "../lib/ipc"
import { agentInfo } from "../lib/agent-kinds"
import { TerminalManager } from "../terminal/terminal-manager"
import { agentIcon } from "./agent-icon"
import { stopPaneMouseDown } from "./pane-hint"

/** Dismissals after which "Not now" is joined by "Don't ask again". */
const OFFER_NEVER_AFTER = 3

/** A strip above a terminal whose agent (Codex) runs with minmux's hooks unapproved. */
// Approving is one-time, inside the agent; minmux never types it (the agent may be on its own
// screens or mid-turn). In the pane's flow, never over the prompt; static.
export function AgentHint({ sessionId }: { sessionId: string }) {
  const hint = useStore((s) => s.agentHint[sessionId])
  const [copied, setCopied] = useState(false)
  useEffect(() => setCopied(false), [hint]) // a new hint hasn't been copied yet
  if (!hint) return null
  const agent = agentInfo(hint.kind)
  const Icon = agentIcon(hint.kind)
  const hide = () => {
    useStore.getState().setAgentHint(sessionId, null)
    requestAnimationFrame(() => TerminalManager.focus(sessionId))
  }
  const showMe = () => {
    ipc.clipboardWrite("/hooks")
    setCopied(true)
    requestAnimationFrame(() => TerminalManager.focus(sessionId))
  }
  const dismiss = (never: boolean) => {
    void ipc.agentHintDismiss(hint.kind, never).catch(() => 0)
    hide()
  }
  return (
    <div className="resume-banner integration-hint" role="status">
      <Icon size={13} />
      <span
        className="hint-text"
        title={`${agent.label} runs minmux's hooks only once you approve them in ${agent.label} (it asks for each new hook definition). Approved once, they stay approved.`}
      >
        <b>Approve minmux in {agent.label}</b> to see every running agent live on the Agents board:
        status, sub-agents, tokens, and resume after restart. One-time: type <code>/hooks</code> in{" "}
        {agent.label}, then press <b>t</b>.{copied && " Copied /hooks."}
      </span>
      <span className="resume-actions">
        <button className="resume-btn primary" onMouseDown={stopPaneMouseDown} onClick={showMe}>
          Show me
        </button>
        {hint.dismissals >= OFFER_NEVER_AFTER && (
          <button
            className="resume-btn"
            onMouseDown={stopPaneMouseDown}
            onClick={() => dismiss(true)}
          >
            Don&apos;t ask again
          </button>
        )}
        <button
          className="resume-btn icon"
          title="Not now"
          aria-label="Not now"
          onMouseDown={stopPaneMouseDown}
          onClick={() => dismiss(false)}
        >
          <X size={11} />
        </button>
      </span>
    </div>
  )
}
