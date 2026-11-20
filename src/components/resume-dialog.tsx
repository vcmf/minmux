import { useEffect, useRef } from "react"
import { focusActiveEntry } from "./refocus-terminal"
import type { AgentKind } from "../lib/agent-graph"
import { agentInfo } from "../lib/agent-kinds"
import { agentIcon } from "./agent-icon"

/** What a resume would open, for the dialog. */
export interface ResumeAsk {
  label: string
  agent: AgentKind
  folder?: string // shown short (~/…)
  where: "here" | "its-pane" // beside the pane you're in, or beside the session's own pane
  busy?: string // main says it may be running elsewhere: why (the button resumes anyway)
}

/** "Resume this session?" before a click starts an agent again (docs/design/AGENTS_PANEL.md). */
export function ResumeDialog({
  ask,
  onResume,
  onCancel,
}: {
  ask: ResumeAsk
  onResume: () => void
  onCancel: () => void
}) {
  const resumeRef = useRef<HTMLButtonElement>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)
  // The latest handler, so a parent re-render (any hook event) never re-runs the effect below:
  // that would pull focus back to Resume while you're on Cancel.
  const cancelNow = useRef(onCancel)
  cancelNow.current = onCancel
  useEffect(() => {
    resumeRef.current?.focus()
    // Window-level, so the trap holds even if focus drifted off the buttons.
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault()
        e.stopPropagation()
        cancelNow.current()
      } else if (e.key === "Tab") {
        // Modal: Tab cycles between the two buttons.
        e.preventDefault()
        const next = document.activeElement === resumeRef.current ? cancelRef : resumeRef
        next.current?.focus()
      }
    }
    window.addEventListener("keydown", onKey, true)
    return () => {
      window.removeEventListener("keydown", onKey, true)
      // Gone (either way): keys go back to the focused terminal if focus was left nowhere.
      requestAnimationFrame(() => {
        if (document.activeElement && document.activeElement !== document.body) return
        focusActiveEntry()
      })
    }
  }, [])
  const Icon = agentIcon(ask.agent)
  return (
    <div className="settings-overlay" onMouseDown={onCancel}>
      <div
        className="confirm-dialog"
        role="alertdialog"
        aria-labelledby="resume-title"
        onMouseDown={(e) => {
          e.stopPropagation()
          e.preventDefault()
        }}
      >
        <h2 id="resume-title">Resume this session?</h2>
        <p className="resume-ask-name">
          <Icon size={12} /> {ask.label}
        </p>
        <p className="status-faint resume-ask-where">
          {agentInfo(ask.agent).label}
          {ask.folder ? ` · ${ask.folder}` : ""}
        </p>
        <p>
          {ask.where === "here"
            ? "Opens in a split beside the pane you're in."
            : "Opens in a split beside its pane."}
        </p>
        {ask.busy && <p className="resume-ask-busy">{ask.busy}.</p>}
        <div className="confirm-actions">
          <button ref={cancelRef} className="btn" onClick={onCancel}>
            Cancel
          </button>
          <button ref={resumeRef} className="btn primary" onClick={onResume}>
            {ask.busy ? "Resume anyway" : "Resume"}
          </button>
        </div>
      </div>
    </div>
  )
}
