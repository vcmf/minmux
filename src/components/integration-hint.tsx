import { FolderOpen, X } from "@phosphor-icons/react"
import { useStore } from "../store"
import { TerminalManager } from "../terminal/terminal-manager"

/** A one-line offer on a split of an ssh pane whose host has no shell integration (ask
 *  mode): turning it on is what makes a split, a reconnect or a relaunch open in the same
 *  folder. In the pane's flow above the terminal (never over its prompt); static. */
export function IntegrationHint({ sessionId }: { sessionId: string }) {
  const hint = useStore((s) =>
    s.integrationHint?.sessionId === sessionId ? s.integrationHint : null,
  )
  if (!hint) return null
  const answer = (choice: "on" | "never" | "dismiss") => {
    useStore.getState().answerIntegrationHint(choice)
    if (choice !== "on") requestAnimationFrame(() => TerminalManager.focus(sessionId))
  }
  const done = () => {
    useStore.getState().answerIntegrationHint("dismiss")
    requestAnimationFrame(() => TerminalManager.focus(sessionId))
  }
  // The pane's own mousedown focuses its terminal: keep it from eating the click.
  const stop = (e: React.MouseEvent) => e.stopPropagation()
  if (hint.state === "on") {
    return (
      <div className="resume-banner ok integration-hint" role="status">
        <FolderOpen size={13} />
        <span
          className="hint-text"
          title={`From ${hint.alias}'s next connection, splits, reconnects and relaunches open in the same folder.`}
        >
          On for <b>{hint.alias}</b> from its next connection
        </span>
        <span className="resume-actions">
          <button className="resume-btn" onMouseDown={stop} onClick={done}>
            OK
          </button>
        </span>
      </div>
    )
  }
  return (
    <div className="resume-banner integration-hint" role="status">
      <FolderOpen size={13} />
      <span
        className="hint-text"
        title={`Splits of ${hint.alias} open at home. With shell integration (smterm's prompt hooks, sent inline for each session) they open in the same folder, and reconnects and relaunches do too.`}
      >
        Open splits of <b>{hint.alias}</b> in the same folder?
      </span>
      <span className="resume-actions">
        <button className="resume-btn primary" onMouseDown={stop} onClick={() => answer("on")}>
          Turn on
        </button>
        <button
          className="resume-btn"
          title={`Don't ask again for ${hint.alias} (shell integration stays off there)`}
          onMouseDown={stop}
          onClick={() => answer("never")}
        >
          Never
        </button>
        <button
          className="resume-btn icon"
          title="Not now"
          aria-label="Not now"
          onMouseDown={stop}
          onClick={() => answer("dismiss")}
        >
          <X size={11} />
        </button>
      </span>
    </div>
  )
}
