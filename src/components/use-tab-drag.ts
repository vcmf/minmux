// Drag & drop reordering of sessions (tabs), shared by the top bar (horizontal) and the
// sidebar (vertical): one order, two views. HTML5 drag with our own payload type, so it
// never mixes with dragging a terminal onto a pane (application/x-smterm-surface).
import { useRef, useState, type DragEvent } from "react"
import { useStore } from "../store"
import { TAB_DRAG_TYPE, insertIndexAt } from "../lib/tab-order"

/** Drag state + handlers for one list of sessions along `axis`. */
export function useTabDrag(axis: "x" | "y") {
  const listRef = useRef<HTMLDivElement>(null)
  const [dragging, setDragging] = useState<string | null>(null)
  // Where the drop would land: index + the indicator's offset inside the list (px).
  const [target, setTarget] = useState<{ index: number; offset: number } | null>(null)

  const items = () =>
    Array.from(listRef.current?.querySelectorAll<HTMLElement>("[data-tab-drag]") ?? [])

  const locate = (e: DragEvent) => {
    const list = listRef.current
    if (!list) return null
    const els = items()
    const spans = els.map((el) => {
      const r = el.getBoundingClientRect()
      return (axis === "x" ? [r.left, r.right] : [r.top, r.bottom]) as [number, number]
    })
    const index = insertIndexAt(spans, axis === "x" ? e.clientX : e.clientY)
    const box = list.getBoundingClientRect()
    const base = axis === "x" ? box.left - list.scrollLeft : box.top - list.scrollTop
    const edge =
      spans.length === 0 ? 0 : index < spans.length ? spans[index]![0] : spans[spans.length - 1]![1]
    return { index, offset: edge - base }
  }

  const isTabDrag = (e: DragEvent) => e.dataTransfer.types.includes(TAB_DRAG_TYPE)

  /** Marks the element whose box counts for a session when placing the drop. */
  const spanProps = (tabId: string) => ({ "data-tab-drag": tabId })

  /** What you grab to drag a session (off while it's being renamed). */
  const handleProps = (tabId: string, enabled = true) => ({
    draggable: enabled,
    onDragStart: (e: DragEvent) => {
      if (!enabled) return
      e.stopPropagation()
      e.dataTransfer.effectAllowed = "move"
      e.dataTransfer.setData(TAB_DRAG_TYPE, tabId)
      setDragging(tabId)
    },
    onDragEnd: () => {
      setDragging(null)
      setTarget(null)
    },
  })

  /** Props for the list that holds the items (the drop zone). */
  const listProps = {
    ref: listRef,
    onDragOver: (e: DragEvent) => {
      if (!isTabDrag(e)) return // a terminal drag: not ours
      e.preventDefault()
      e.dataTransfer.dropEffect = "move"
      const t = locate(e)
      if (t && (t.index !== target?.index || t.offset !== target?.offset)) setTarget(t)
    },
    onDragLeave: (e: DragEvent) => {
      // Only when leaving the list itself, not moving between its children.
      if (!listRef.current?.contains(e.relatedTarget as Node | null)) setTarget(null)
    },
    onDrop: (e: DragEvent) => {
      if (!isTabDrag(e)) return
      e.preventDefault()
      const id = e.dataTransfer.getData(TAB_DRAG_TYPE)
      const t = locate(e)
      if (id && t) useStore.getState().moveTab(id, t.index)
      setDragging(null)
      setTarget(null)
    },
  }

  /** One element that is both the span and the handle (a top-bar tab). */
  const itemProps = (tabId: string, enabled = true) => ({
    ...spanProps(tabId),
    ...handleProps(tabId, enabled),
  })

  return { listProps, itemProps, spanProps, handleProps, dragging, target }
}
