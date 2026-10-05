import { useStore } from "../store"
import { TerminalManager } from "../terminal/terminal-manager"

/** Give the keyboard back to the active terminal (after a rename or a menu) — unless by the
 *  next frame something else took it (a text field, the close dialog, a new split). */
export function refocusActiveTerminal(): void {
  requestAnimationFrame(() => {
    const el = document.activeElement
    if (el && el !== document.body) return
    const s = useStore.getState()
    const sid = s.tabs.find((t) => t.id === s.activeTabId)?.activeSessionId
    if (sid) TerminalManager.focus(sid)
  })
}
