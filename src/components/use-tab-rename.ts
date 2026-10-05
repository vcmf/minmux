import { useEffect, useRef, useState, type ChangeEvent, type KeyboardEvent } from "react"
import { useStore } from "../store"
import { refocusActiveTerminal } from "./refocus-terminal"

type Stoppable = { stopPropagation: () => void }

/** Inline rename of a session (tab), shared by the top bar and the sidebar: Enter or a blur
 *  saves, Escape cancels, an empty name changes nothing. Each edit ends exactly once, so the
 *  blur that follows Enter / Escape (the input unmounting) can't save twice or undo a cancel. */
export function useTabRename() {
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState("")
  const inputRef = useRef<HTMLInputElement>(null)
  const live = useRef<{ id: string; initial: string } | null>(null) // the edit in progress

  useEffect(() => {
    if (editingId && inputRef.current) {
      inputRef.current.focus()
      inputRef.current.select()
    }
  }, [editingId])

  /** Edit `tabId`, pre-filled with `title` (its name as shown, without the live "+N"). */
  const start = (tabId: string, title: string) => {
    if (live.current?.id === tabId) return // already editing it: keep what's typed
    live.current = { id: tabId, initial: title }
    setDraft(title)
    setEditingId(tabId)
  }
  /** `explicit`: Enter, which pins even the unchanged name; a blur only saves an edit (so
   *  clicking away from an untouched field leaves an unnamed session following its pane). */
  const end = (save: boolean, value: string, explicit = false) => {
    const edit = live.current
    if (!edit) return // already ended
    live.current = null
    setEditingId(null)
    const name = value.trim()
    if (!save || !name || (!explicit && name === edit.initial.trim())) return
    useStore.getState().renameTab(edit.id, name)
  }

  const inputProps = {
    ref: inputRef,
    value: draft,
    onChange: (e: ChangeEvent<HTMLInputElement>) => setDraft(e.target.value),
    onBlur: (e: { currentTarget: HTMLInputElement }) => {
      // The window lost focus (⌘Tab): keep editing, Chromium refocuses the field on return.
      if (!document.hasFocus()) return
      end(true, e.currentTarget.value)
    },
    // Typing in the field must not select the tab, start a drag, toggle its row, or open
    // the row's own menu (its actions would race the edit).
    onMouseDown: (e: Stoppable) => e.stopPropagation(),
    onDoubleClick: (e: Stoppable) => e.stopPropagation(),
    onContextMenu: (e: Stoppable) => e.stopPropagation(),
    onKeyDown: (e: KeyboardEvent<HTMLInputElement>) => {
      if (e.key !== "Enter" && e.key !== "Escape") return
      if (e.nativeEvent.isComposing) return // the IME's own Enter / Escape (pick, cancel)
      e.preventDefault()
      e.stopPropagation()
      end(e.key === "Enter", e.currentTarget.value, true)
      refocusActiveTerminal() // a keyboard finish goes back to typing in the terminal
    },
  }

  return { editingId, start, inputProps }
}
