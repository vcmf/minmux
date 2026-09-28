import { useEffect, useRef } from "react"
import { useStore } from "../store"
import { TerminalManager } from "../terminal/terminal-manager"
import { closeConfirmText } from "../lib/close-confirm"
import { findPaneById } from "../lib/pane-tree"

/** "Are you sure?" before a close that would kill work: a pane of several terminals, a
 *  session, or a running terminal — rules + wording in lib/close-confirm. */
export function ClosePaneDialog() {
  const pending = useStore((s) => s.closeConfirm)
  // Its target closed some other way meanwhile (a direct close, an ssh drop…) → nothing to ask.
  const gone = useStore((s) => {
    const c = s.closeConfirm
    if (!c) return false
    const tab = s.tabs.find((t) => t.id === c.tabId)
    if (!tab) return true
    if (c.kind === "terminal") return !s.sessions[c.sessionId]
    if (c.kind === "pane") return !findPaneById(tab.root, c.paneId)
    return false
  })
  useEffect(() => {
    if (gone) useStore.getState().cancelClose()
  }, [gone])
  const confirmRef = useRef<HTMLButtonElement>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)

  // Hand keyboard focus back to the focused terminal once the dialog is gone.
  const refocus = () =>
    requestAnimationFrame(() => {
      const s = useStore.getState()
      const sid = s.tabs.find((t) => t.id === s.activeTabId)?.activeSessionId
      if (sid) TerminalManager.focus(sid)
    })
  const cancel = () => {
    useStore.getState().cancelClose()
    refocus()
  }
  const confirm = () => {
    useStore.getState().confirmClose()
    refocus()
  }

  useEffect(() => {
    if (!pending) return
    confirmRef.current?.focus()
    // Window-level, so the trap holds even if focus drifted off the buttons.
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault()
        cancel()
      } else if (e.key === "Tab") {
        // Modal: Tab cycles between the two buttons, never out to the terminal behind.
        e.preventDefault()
        const next = document.activeElement === confirmRef.current ? cancelRef : confirmRef
        next.current?.focus()
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending])

  if (!pending || gone) return null
  const text = closeConfirmText(pending)
  return (
    <div className="settings-overlay" onMouseDown={cancel}>
      <div
        className="confirm-dialog"
        role="alertdialog"
        aria-labelledby="close-confirm-title"
        // preventDefault: clicking the dialog's text must not blur the focused button.
        onMouseDown={(e) => {
          e.stopPropagation()
          e.preventDefault()
        }}
      >
        <h2 id="close-confirm-title">{text.title}</h2>
        <p>{text.body}</p>
        <div className="confirm-actions">
          <button ref={cancelRef} className="btn" onClick={cancel}>
            Cancel
          </button>
          <button ref={confirmRef} className="btn danger" onClick={confirm}>
            {text.action}
          </button>
        </div>
      </div>
    </div>
  )
}
