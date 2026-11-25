// The fleet graph's camera input (docs/design/FLEET_GRAPH.md, "The graph"): how a wheel, a key or a
// focused card moves the camera. Pure; the view wires them to its events.
import { toScreen, type Camera, type FleetNode } from "./fleet-layout"

// Lines and pages in px (a page: the view's width sideways, its height down); shift turns a mouse
// wheel sideways; a ctrl / pinch wheel is no pan.
/** A wheel event's pan in px, or null. */
export function wheelPan(
  e: { deltaX: number; deltaY: number; deltaMode: number; shiftKey: boolean; ctrlKey: boolean },
  page: { w: number; h: number },
): { dx: number; dy: number } | null {
  if (e.ctrlKey) return null
  const sideways = e.shiftKey && !e.deltaX
  const ux = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? page.w : 1
  const uy = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? page.h : 1
  return sideways ? { dx: e.deltaY * ux, dy: 0 } : { dx: e.deltaX * ux, dy: e.deltaY * uy }
}

// Arrows a step, Page Up/Down most of a screen, Home back to the centre; nothing with a modifier.
/** What a key does to the camera: a pan, `home`, or nothing. */
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

// `top`: where the visible part starts (below the dock of other repos when it's shown); a root
// counts with its label (240px wide, about 60px below the circle), as `bounds` does.
/** Whether a card shows whole in the view. */
export function cardInView(
  n: FleetNode,
  cam: Camera,
  view: { w: number; h: number; top: number },
  margin = 24,
): boolean {
  const { x, y } = toScreen(n, cam, view.w, view.h)
  const half = n.kind === "root" ? Math.max(n.w, 240) / 2 : n.w / 2
  const below = n.kind === "root" ? 60 : 0
  return (
    x - half >= margin &&
    x + half <= view.w - margin &&
    y - n.h / 2 >= view.top + margin &&
    y + n.h / 2 + below <= view.h - margin
  )
}

export const ZOOM_MIN = 0.4
export const ZOOM_MAX = 2

/** A zoom kept in its range, rounded (no 0.9999 from repeated steps). */
export const clampZoom = (z: number) =>
  Math.round(Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z)) * 1000) / 1000

/** The camera after zooming `z` → `nz` about a view point (`at`; the middle when absent). */
export function zoomAt(
  cam: { x: number; y: number },
  z: number,
  nz: number,
  view: { w: number; h: number },
  at?: { x: number; y: number },
): { x: number; y: number } {
  const ox = (at?.x ?? view.w / 2) - view.w / 2
  const oy = (at?.y ?? view.h / 2) - view.h / 2
  return { x: cam.x + ox / z - ox / nz, y: cam.y + oy / z - oy / nz }
}

/** A wheel's zoom step (a pinch, or ctrl/cmd with the wheel): the new zoom, or null for none. */
export function wheelZoom(
  e: { deltaY: number; deltaMode: number; ctrlKey: boolean; metaKey: boolean },
  z: number,
): number | null {
  if (!e.ctrlKey && !e.metaKey) return null
  const px = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY
  // (unrounded: a slow pinch's tiny steps add up, none lost to rounding)
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z * Math.exp(-px * 0.0025)))
}

/** A key's zoom step (+, -, 0 for 100%): the new zoom, or null for none. */
export function keyZoom(
  e: { key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean },
  z: number,
): number | null {
  if (e.metaKey || e.ctrlKey || e.altKey) return null
  if (e.key === "+" || e.key === "=") return clampZoom(z * 1.2)
  if (e.key === "-" || e.key === "_") return clampZoom(z / 1.2)
  if (e.key === "0") return 1
  return null
}
