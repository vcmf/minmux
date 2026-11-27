import { useEffect, useRef } from "react"
import { useStore } from "../store"
import { focusActiveEntry } from "./refocus-terminal"
import { closeConfirmText } from "../lib/close-confirm"

/** "Are you sure?" before a close that would kill work: a pane of several terminals, a
 *  session, or a running terminal — rules + wording in lib/close-confirm. */
export function CloseConfirmDialog() {
  const pending = useStore((s) => s.closeConfirm)
  // However it goes away — a button, or the store dropping it because its target closed
  // some other way — focus returns to the active terminal if it was left nowhere.
  const wasOpen = useRef(false)
  useEffect(() => {
    if (pending) wasOpen.current = true
    else if (wasOpen.current) {
      wasOpen.current = false
      if (!document.activeElement || document.activeElement === document.body) refocus()
    }
  }, [pending])
  const confirmRef = useRef<HTMLButtonElement>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)
  const saveRef = useRef<HTMLButtonElement>(null) // a file's close: Save

  // Hand keyboard focus back to the focused terminal once the dialog is gone.
  const refocus = () => requestAnimationFrame(focusActiveEntry)
  const cancel = () => {
    useStore.getState().cancelClose()
    refocus()
  }
  const confirm = () => {
    useStore.getState().confirmClose()
    refocus()
  }
  const save = () => void useStore.getState().saveAndClose()

  useEffect(() => {
    if (!pending) return
    ;(saveRef.current ?? confirmRef.current)?.focus()
    // Window-level, so the trap holds even if focus drifted off the buttons.
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault()
        cancel()
      } else if (e.key === "Tab") {
        // Modal: Tab cycles through the buttons, never out to the terminal behind.
        e.preventDefault()
        const order = [cancelRef, confirmRef, saveRef].filter((r) => r.current)
        const at = order.findIndex((r) => r.current === document.activeElement)
        const step = e.shiftKey ? order.length - 1 : 1
        order[(at + step) % order.length]?.current?.focus()
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending])

  if (!pending) return null
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
          {pending.kind === "file" && (
            <button ref={saveRef} className="btn primary" onClick={save}>
              Save
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
