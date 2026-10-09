// A terminal drag can outlive its source element: spring-loading another group open unmounts
// the dragged surface tab, and a detached element's dragend never reaches us. So while a drag
// is on, the window ends it on any drop / dragend, or on the first mouse move or press after
// it (Chromium sends none during a drag). Deferred, so drop handlers still see the drag.
import { useEffect } from "react"
import { useStore } from "../store"

export function useSurfaceDragGuard(): void {
  const dragging = useStore((s) => s.dragging)
  useEffect(() => {
    if (!dragging) return
    const end = () => {
      cleanup()
      setTimeout(() => {
        if (useStore.getState().dragging === dragging) useStore.getState().setDragging(null)
      }, 0)
    }
    const events = ["dragend", "drop", "mousemove", "mousedown"] as const
    const cleanup = () => events.forEach((ev) => window.removeEventListener(ev, end, true))
    events.forEach((ev) => window.addEventListener(ev, end, true))
    return cleanup
  }, [dragging])
}
