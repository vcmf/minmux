// The fleet graph's camera input (docs/design/FLEET_GRAPH.md, "The graph"): how a wheel, a key or a
// focused card moves the camera. Pure; the view wires them to its events.
import { toScreen, type Camera, type FleetNode } from "./fleet-layout"

/** A wheel event's pan in px: lines and pages scaled, shift turning a mouse wheel sideways; a
 *  ctrl / pinch wheel is no pan (null). */
export function wheelPan(
  e: { deltaX: number; deltaY: number; deltaMode: number; shiftKey: boolean; ctrlKey: boolean },
  pageH: number,
): { dx: number; dy: number } | null {
  if (e.ctrlKey) return null
  const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? pageH : 1
  const sideways = e.shiftKey && !e.deltaX
  return { dx: (sideways ? e.deltaY : e.deltaX) * unit, dy: (sideways ? 0 : e.deltaY) * unit }
}

/** What a key does to the camera: a pan (arrows a step, Page Up/Down most of a screen), `home`
 *  (back to the view's centre), or nothing (another key, or one with a modifier held). */
export function keyPan(
  e: { key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean },
  pageH: number,
): { dx: number; dy: number } | "home" | null {
  if (e.metaKey || e.ctrlKey || e.altKey) return null
  const step = 80
  const page = pageH * 0.8
  switch (e.key) {
    case "ArrowLeft":
      return { dx: -step, dy: 0 }
    case "ArrowRight":
      return { dx: step, dy: 0 }
    case "ArrowUp":
      return { dx: 0, dy: -step }
    case "ArrowDown":
      return { dx: 0, dy: step }
    case "PageUp":
      return { dx: 0, dy: -page }
    case "PageDown":
      return { dx: 0, dy: page }
    case "Home":
      return "home"
    default:
      return null
  }
}

/** Whether a card shows whole in the view: `top` is where the visible part starts (below the
 *  dock of other repos when it's shown). */
export function cardInView(
  n: FleetNode,
  cam: Camera,
  view: { w: number; h: number; top: number },
  margin = 24,
): boolean {
  const { x, y } = toScreen(n, cam, view.w, view.h)
  return (
    x - n.w / 2 >= margin &&
    x + n.w / 2 <= view.w - margin &&
    y - n.h / 2 >= view.top + margin &&
    y + n.h / 2 <= view.h - margin
  )
}
