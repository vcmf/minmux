import { useState } from "react"
import { ArrowCounterClockwise, Check, Warning } from "@phosphor-icons/react"
import { useStore } from "../store"
import { ipc } from "../lib/ipc"
import { isPosixShell, sessionLabel, withCd } from "../lib/resume"
import { agentInfo } from "../lib/agent-kinds"
import { TerminalManager } from "../terminal/terminal-manager"

/** A slim strip above a restored terminal saying what happened to the agent session it was in
 *  (resuming → resumed, or why not, with next steps). Static: no animation over WebGL. */
export function ResumeBanner({ sessionId }: { sessionId: string }) {
  const r = useStore((s) => s.resume[sessionId])
  // A program is in the foreground (OSC 133 C..D) — typing now would go INTO it (a running
  // agent, vim…), so the buttons that type wait until the shell is back at its prompt.
  const busy = useStore((s) => !!s.sessions[sessionId]?.running)
  const [waiting, setWaiting] = useState(false) // a click came before the shell's prompt
  if (!r) return null
  const label = sessionLabel(r.plan)
  const agent = agentInfo(r.plan.agent)
  // An agent's picker lists the CURRENT project's sessions — the one this banner is about
  // lives in plan.cwd, which (ask mode / WSL) may not be the shell's cwd.
  const shell = useStore.getState().sessions[sessionId]?.command ?? ""
  const pickCommand = isPosixShell(shell)
    ? withCd(r.plan.cwd, agent.resumePicker)
    : agent.resumePicker

  const close = () => {
    TerminalManager.resumeSettled(sessionId)
    useStore.getState().setResume(sessionId, null)
    requestAnimationFrame(() => TerminalManager.focus(sessionId))
  }
  const dismiss = () => {
    ipc.resumeConsume(sessionId, r.plan.sessionId) // don't offer it again on the next launch
    close()
  }
  const run = (command: string) => {
    if (TerminalManager.runCommand(sessionId, command)) close()
    else {
      // Refused until the shell shows its prompt — say so rather than looking broken.
      setWaiting(true)
      setTimeout(() => setWaiting(false), 2500)
    }
  }
  const retry = () => {
    // Refused until the shell shows its prompt (its rc may still be running) — say so.
    if (!TerminalManager.resumeNow(sessionId)) {
      setWaiting(true)
      setTimeout(() => setWaiting(false), 2500)
      return
    }
    requestAnimationFrame(() => TerminalManager.focus(sessionId))
  }
  // Buttons act on this pane; keep the pane's own mousedown (focus) from interfering. The
  // ones that type are disabled while a program runs in the foreground.
  const btn = (text: string, onClick: () => void, primary = false, types = true) => (
    <button
      className={`resume-btn${primary ? " primary" : ""}`}
      disabled={types && busy}
      title={types && busy ? "Exit the running program first" : undefined}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={onClick}
    >
      {text}
    </button>
  )

  switch (r.phase) {
    case "pending":
    case "resuming":
      return (
        <div className="resume-banner" role="status">
          <ArrowCounterClockwise size={13} />
          <span>
            Resuming {agent.label} session <b>{label}</b>…
          </span>
        </div>
      )
    case "resumed":
      return (
        <div className="resume-banner ok" role="status">
          <Check size={13} weight="bold" />
          <span>
            Resumed <b>{label}</b>
          </span>
        </div>
      )
    case "waiting":
      return (
        <div className="resume-banner" role="status">
          <ArrowCounterClockwise size={13} />
          <span>
            Resuming {agent.label} session <b>{label}</b>…{" "}
            {agent.confirmsOnPrompt
              ? `${agent.label} confirms when you send a message${agent.hookApproval ? " (if minmux's hooks are approved)" : ""}.`
              : `${agent.label} hasn't confirmed yet: it may be showing a screen of its own.`}
          </span>
          <span className="resume-actions">{btn("Dismiss", close, false, false)}</span>
        </div>
      )
    case "sent":
      return (
        <div className="resume-banner" role="status">
          <ArrowCounterClockwise size={13} />
          <span>
            Sent <b>{r.plan.command ?? agent.resumePicker}</b> for <b>{label}</b> — this shell
            can&apos;t confirm it.
          </span>
          <span className="resume-actions">{btn("Dismiss", close, false, false)}</span>
        </div>
      )
    case "offer":
      return (
        <div className="resume-banner" role="status">
          <ArrowCounterClockwise size={13} />
          <span>
            This pane was in {agent.label} session <b>{label}</b>.
          </span>
          <span className="resume-actions">
            {btn(waiting ? "Waiting for the prompt…" : "Resume", retry, true)}
            {btn("Dismiss", dismiss, false, false)}
          </span>
        </div>
      )
    case "failed":
      return (
        <div className="resume-banner warn" role="alert">
          <Warning size={13} weight="fill" />
          <span>
            Couldn&apos;t resume <b>{label}</b>
            {r.exitCode !== undefined ? ` (${agent.command} exited ${r.exitCode})` : ""}.
          </span>
          <span className="resume-actions">
            {btn(waiting ? "Waiting for the prompt…" : "Retry", retry, true)}
            {btn(
              waiting ? "Waiting for the prompt…" : (agent.resumePickerLabel ?? "Pick a session…"),
              () => run(pickCommand),
            )}
            {btn("Dismiss", dismiss, false, false)}
          </span>
        </div>
      )
    case "skipped":
      return (
        <div className="resume-banner warn" role="alert">
          <Warning size={13} weight="fill" />
          <span>
            Couldn&apos;t resume <b>{label}</b>: {r.plan.reason ?? "it can't be found"}.
          </span>
          <span className="resume-actions">
            {btn(
              waiting ? "Waiting for the prompt…" : `Start ${agent.label} here`,
              () => run(agent.command),
              true,
            )}
            {btn("Dismiss", dismiss, false, false)}
          </span>
        </div>
      )
  }
}
