// Drag & drop on the list of sessions (groups), shared by the top bar (horizontal) and the
// sidebar (vertical): one order, two views. Two kinds of drag land here:
//  - a group (its tab / header): reorder — our own payload type;
//  - a terminal (SURFACE_DRAG_TYPE, from a pane's tab strip or a sidebar row): onto a group's
//    middle joins it (hovering SPRING_MS opens it, to drop on an exact pane), onto an edge or a
//    gap makes it a new group there.
import { useEffect, useRef, useState, type DragEvent } from "react"
import { useStore } from "../store"
import { TAB_DRAG_TYPE } from "../lib/tab-order"
import { insertIndex } from "../lib/drop-zone"
import { TerminalManager } from "../terminal/terminal-manager"
import { SURFACE_DRAG_TYPE, canDrop, type GroupDrop } from "../lib/group-move"

const EDGE = 28 // px from the list's edge where dragging scrolls it (an overflowing tab bar)
const STEP = 14 // px scrolled per dragover there
export const SPRING_MS = 600 // a terminal held over a group this long opens it
const JOIN_EDGE = 10 // px at each end of a group that mean "a new group here", not "join"

/** Drag state + handlers for one list of sessions along `axis`. */
export function useTabDrag(axis: "x" | "y") {
  const listRef = useRef<HTMLDivElement>(null)
  const [dragging, setDragging] = useState<string | null>(null)
  // Where the drop would land: index + the indicator's offset inside the list (px).
  const [target, setTarget] = useState<{ index: number; offset: number } | null>(null)
  const dragId = useRef<string | null>(null)
  // A dragged terminal held over a group: that group (highlighted; dropping joins it).
  const [joinId, setJoinId] = useState<string | null>(null)
  const spring = useRef<{ tabId: string; timer: ReturnType<typeof setTimeout> } | null>(null)
  const stopSpring = () => {
    if (spring.current) clearTimeout(spring.current.timer)
    spring.current = null
  }

  const reset = () => {
    dragId.current = null
    setDragging(null)
    setTarget(null)
    setJoinId(null)
    stopSpring()
  }
  // A terminal drag that ends anywhere (another drop target, Esc) clears our hints.
  const surfaceDragging = useStore((s) => !!s.dragging)
  useEffect(() => {
    if (!surfaceDragging) {
      setJoinId(null)
      stopSpring()
      if (!dragId.current) setTarget(null)
    }
  }, [surfaceDragging])
  useEffect(() => stopSpring, [])

  // A lost dragend (the dragged element unmounted mid-drag) mustn't leave a stale line.
  useEffect(() => {
    if (!dragging) return
    const end = () => reset()
    window.addEventListener("dragend", end, true)
    window.addEventListener("drop", end, true)
    return () => {
      window.removeEventListener("dragend", end, true)
      window.removeEventListener("drop", end, true)
    }
  }, [dragging])

  const items = () =>
    Array.from(listRef.current?.querySelectorAll<HTMLElement>("[data-tab-drag]") ?? [])

  const locate = (e: DragEvent) => {
    const list = listRef.current
    if (!list) return null
    const els = items()
    const rects = els.map((el) => {
      const r = el.getBoundingClientRect()
      return axis === "x" ? { left: r.left, width: r.width } : { left: r.top, width: r.height }
    })
    const index = insertIndex(rects, axis === "x" ? e.clientX : e.clientY)
    // Dropping right before / after the dragged session changes nothing: no line there.
    const from = els.findIndex((el) => el.dataset.tabDrag === dragId.current)
    if (from >= 0 && (index === from || index === from + 1)) return { index, offset: -1 }
    const box = list.getBoundingClientRect()
    const base = axis === "x" ? box.left - list.scrollLeft : box.top - list.scrollTop
    const last = rects[rects.length - 1]
    const edge = index < rects.length ? rects[index]!.left : last ? last.left + last.width : base
    return { index, offset: edge - base }
  }

  // Dragging near an edge of an overflowing list scrolls it, so every slot is reachable.
  const autoScroll = (e: DragEvent) => {
    const list = listRef.current
    if (!list) return
    const box = list.getBoundingClientRect()
    const pos = axis === "x" ? e.clientX - box.left : e.clientY - box.top
    const size = axis === "x" ? box.width : box.height
    const delta = pos < EDGE ? -STEP : pos > size - EDGE ? STEP : 0
    if (delta) list.scrollBy(axis === "x" ? { left: delta } : { top: delta })
  }

  const isTabDrag = (e: DragEvent) => e.dataTransfer.types.includes(TAB_DRAG_TYPE)
  const isSurfaceDrag = (e: DragEvent) =>
    e.dataTransfer.types.includes(SURFACE_DRAG_TYPE) && !!useStore.getState().dragging

  /** Where a dragged terminal would land: a group's middle (join) or a gap (a new group). */
  const locateSurface = (e: DragEvent): { drop: GroupDrop; offset: number } | null => {
    const list = listRef.current
    if (!list) return null
    const pos = axis === "x" ? e.clientX : e.clientY
    for (const el of items()) {
      const r = el.getBoundingClientRect()
      const start = axis === "x" ? r.left : r.top
      const size = axis === "x" ? r.width : r.height
      if (pos < start || pos > start + size) continue
      const band = Math.min(JOIN_EDGE, size / 4)
      if (pos - start >= band && start + size - pos >= band)
        return { drop: { kind: "join", tabId: el.dataset.tabDrag! }, offset: -1 }
      break // an edge: the gap next to it
    }
    const t = locate(e) // the gap under the pointer (same geometry as a reorder)
    return t ? { drop: { kind: "new", insertAt: t.index }, offset: t.offset } : null
  }

  // Hold a terminal over a group: after SPRING_MS that group opens (drop onto a pane there).
  const armSpring = (tabId: string | null) => {
    if (spring.current?.tabId === tabId) return
    stopSpring()
    if (!tabId) return
    spring.current = {
      tabId,
      timer: setTimeout(() => {
        spring.current = null
        const s = useStore.getState()
        if (s.dragging && s.activeTabId !== tabId) s.setActiveTab(tabId)
      }, SPRING_MS),
    }
  }

  const onSurfaceOver = (e: DragEvent) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = "move"
    autoScroll(e)
    const s = useStore.getState()
    const hit = locateSurface(e)
    const ok = !!hit && canDrop(s.tabs, s.dragging!.sessionId, hit.drop)
    const join = ok && hit.drop.kind === "join" ? hit.drop.tabId : null
    if (join !== joinId) setJoinId(join)
    armSpring(join)
    const line =
      ok && hit.drop.kind === "new" ? { index: hit.drop.insertAt, offset: hit.offset } : null
    if (line?.index !== target?.index || line?.offset !== target?.offset) setTarget(line)
  }

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
      dragId.current = tabId
      // Dim it a frame later: Chromium snapshots the drag image right after dragstart.
      requestAnimationFrame(() => {
        if (dragId.current === tabId) setDragging(tabId)
      })
    },
    onDragEnd: () => {
      reset()
      // The press moved focus off the terminal and the drag swallowed the mouseup: give it back.
      const s = useStore.getState()
      const sid = s.tabs.find((t) => t.id === s.activeTabId)?.activeSessionId
      if (sid) requestAnimationFrame(() => TerminalManager.focus(sid))
    },
  })

  /** One element that is both the span and the handle (a top-bar tab). */
  const itemProps = (tabId: string, enabled = true) => ({
    ...spanProps(tabId),
    ...handleProps(tabId, enabled),
  })

  /** Props for the list that holds the items (the drop zone). */
  const listProps = {
    ref: listRef,
    onDragOver: (e: DragEvent) => {
      if (isSurfaceDrag(e)) return onSurfaceOver(e)
      if (!isTabDrag(e)) return
      e.preventDefault()
      e.dataTransfer.dropEffect = "move"
      autoScroll(e)
      const t = locate(e)
      if (t && (t.index !== target?.index || t.offset !== target?.offset)) setTarget(t)
    },
    onDragLeave: (e: DragEvent) => {
      // Only when leaving the list itself, not moving between its children.
      if (!listRef.current?.contains(e.relatedTarget as Node | null)) {
        setTarget(null)
        setJoinId(null)
        stopSpring()
      }
    },
    onDrop: (e: DragEvent) => {
      if (isSurfaceDrag(e)) {
        e.preventDefault()
        const s = useStore.getState()
        const hit = locateSurface(e)
        const sessionId = s.dragging!.sessionId
        setTarget(null)
        setJoinId(null)
        stopSpring()
        if (hit && canDrop(s.tabs, sessionId, hit.drop)) s.moveTerminal(sessionId, hit.drop)
        else s.setDragging(null)
        return
      }
      if (!isTabDrag(e)) return
      e.preventDefault()
      const id = e.dataTransfer.getData(TAB_DRAG_TYPE)
      const t = locate(e)
      if (id && t) useStore.getState().moveTab(id, t.index)
      reset()
    },
  }

  // A no-op slot is still tracked (so the line can reappear) but not drawn.
  const shown = target && target.offset >= 0 ? target : null
  return { listProps, itemProps, spanProps, handleProps, dragging, target: shown, joinId }
}
