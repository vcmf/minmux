import { useEffect, useRef, useState, type ChangeEvent, type KeyboardEvent } from "react"
import { useStore } from "../store"
import { TerminalManager } from "../terminal/terminal-manager"

/** Give the keyboard back to the active terminal (after a rename or a menu) — unless by the
 *  next frame something else took it (a rename field, the close dialog). */
export function refocusActiveTerminal(): void {
  requestAnimationFrame(() => {
    const el = document.activeElement
    if (el && el !== document.body) return
    const s = useStore.getState()
    const sid = s.tabs.find((t) => t.id === s.activeTabId)?.activeSessionId
    if (sid) TerminalManager.focus(sid)
  })
}

/** Inline rename of a session (tab), shared by the top bar and the sidebar: Enter or a blur
 *  saves, Escape cancels, an empty name changes nothing. Each edit ends exactly once, so the
 *  blur that follows Enter / Escape (the input unmounting) can't save twice or undo a cancel. */
export function useTabRename() {
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState("")
  const inputRef = useRef<HTMLInputElement>(null)
  const live = useRef<string | null>(null) // the edit in progress (read synchronously)

  useEffect(() => {
    if (editingId && inputRef.current) {
      inputRef.current.focus()
      inputRef.current.select()
    }
  }, [editingId])

  const start = (tabId: string, title: string) => {
    live.current = tabId
    setDraft(title)
    setEditingId(tabId)
  }
  const end = (save: boolean, value: string) => {
    const id = live.current
    if (!id) return // already ended
    live.current = null
    setEditingId(null)
    const name = value.trim()
    if (save && name) useStore.getState().renameTab(id, name)
  }

  const inputProps = {
    ref: inputRef,
    value: draft,
    onChange: (e: ChangeEvent<HTMLInputElement>) => setDraft(e.target.value),
    onBlur: (e: { currentTarget: HTMLInputElement }) => end(true, e.currentTarget.value),
    // Typing in the field must not select the tab, start a drag, or toggle its row.
    onMouseDown: (e: { stopPropagation: () => void }) => e.stopPropagation(),
    onDoubleClick: (e: { stopPropagation: () => void }) => e.stopPropagation(),
    onKeyDown: (e: KeyboardEvent<HTMLInputElement>) => {
      if (e.key !== "Enter" && e.key !== "Escape") return
      e.preventDefault()
      e.stopPropagation()
      end(e.key === "Enter", e.currentTarget.value)
      refocusActiveTerminal() // a keyboard finish goes back to typing in the terminal
    },
  }

  return { editingId, start, inputProps }
}
