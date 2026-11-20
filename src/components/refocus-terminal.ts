import { focusedTerminal, useStore } from "../store"
import { TerminalManager } from "../terminal/terminal-manager"

/** Give the keyboard to the active tab's focused entry, now. */
export function focusActiveEntry(): void {
  const sid = focusedTerminal(useStore.getState())
  if (sid) TerminalManager.focus(sid)
}

/** Give the keyboard back to the active entry (after a rename or a menu) — unless by the
 *  next frame something else took it (a text field, the close dialog, a new split). */
export function refocusActiveTerminal(): void {
  requestAnimationFrame(() => {
    const el = document.activeElement
    if (el && el !== document.body) return
    focusActiveEntry()
  })
}

/** Keys back to the dialog a control is in (the focused button is going away). */
export const toDialog = (el: HTMLElement) => el.closest<HTMLElement>("[role=dialog]")?.focus()
