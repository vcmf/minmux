import { useStore } from "../store"
import { isTerminalEntry } from "../lib/entries"
import { TerminalManager } from "../terminal/terminal-manager"

/** Give the keyboard to entry `id`: a terminal, or a folder / file view (its element). */
export function focusEntry(id: string): void {
  if (isTerminalEntry(id)) TerminalManager.focus(id)
  else document.querySelector<HTMLElement>(`[data-entry="${id}"]`)?.focus()
}

/** Entry `id` of tab `tabId` is where the store says the keyboard is. */
export function isFocusedEntry(tabId: string, id: string): boolean {
  const s = useStore.getState()
  if (s.activeView || s.activeTabId !== tabId) return false
  // An overlay has the keyboard (palette, settings, PR dialog, a preview): not a pane.
  if (s.paletteOpen || s.settingsOpen || s.prDialogOpen || s.preview) return false
  return s.tabs.find((t) => t.id === tabId)?.activeEntryId === id
}

/** Give the keyboard to the active tab's focused entry, now. */
export function focusActiveEntry(): void {
  const s = useStore.getState()
  if (s.activeView) return // the panes are parked behind a view: never focus an inert terminal
  const id = s.tabs.find((t) => t.id === s.activeTabId)?.activeEntryId
  if (id) focusEntry(id)
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
