import { FolderOpen, X } from "@phosphor-icons/react"
import { hintStillAsks, useStore } from "../store"
import { TerminalManager } from "../terminal/terminal-manager"
import { stopPaneMouseDown } from "./pane-hint"

/** A one-line offer on a split of an ssh pane whose host has no shell integration (ask
 *  mode): turning it on is what makes a split, a reconnect or a relaunch open in the same
 *  folder. In the pane's flow above the terminal (never over its prompt); static. */
export function IntegrationHint({ sessionId }: { sessionId: string }) {
  const hint = useStore((s) =>
    s.integrationHint?.sessionId === sessionId ? s.integrationHint : null,
  )
  // Decided meanwhile (the host menu, Settings → Off / All hosts): the question is gone.
  const asks = useStore((s) => !!hint && hintStillAsks(hint.alias, s.settings.ssh))
  if (!hint || (hint.state === "ask" && !asks)) return null
  const answer = (choice: "on" | "never" | "dismiss") => {
    useStore.getState().answerIntegrationHint(choice)
    requestAnimationFrame(() => TerminalManager.focus(sessionId)) // typing goes on in the shell
  }
  const done = () => {
    useStore.getState().answerIntegrationHint("dismiss")
    requestAnimationFrame(() => TerminalManager.focus(sessionId))
  }
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
          <button className="resume-btn" onMouseDown={stopPaneMouseDown} onClick={done}>
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
        title={`Splits of ${hint.alias} open at home. With shell integration (minmux's prompt hooks, sent inline for each session) they open in the same folder, and reconnects and relaunches do too — unless its ssh config runs a RemoteCommand.`}
      >
        Open splits of <b>{hint.alias}</b> in the same folder?
      </span>
      <span className="resume-actions">
        <button
          className="resume-btn primary"
          onMouseDown={stopPaneMouseDown}
          onClick={() => answer("on")}
        >
          Turn on
        </button>
        <button
          className="resume-btn"
          title={`Don't ask again for ${hint.alias} (shell integration stays off there)`}
          onMouseDown={stopPaneMouseDown}
          onClick={() => answer("never")}
        >
          Never
        </button>
        <button
          className="resume-btn icon"
          title="Not now"
          aria-label="Not now"
          onMouseDown={stopPaneMouseDown}
          onClick={() => answer("dismiss")}
        >
          <X size={11} />
        </button>
      </span>
    </div>
  )
}
