// The fleet graph's motion (docs/design/FLEET_GRAPH.md, "Motion"): the open repo's slow turn, the
// grow-out when it opens, the dots on working agents' edges, and when the loop may run at all.
// Pure; the view's one throttled loop calls them.
import { FLEET, type FleetNode } from "./fleet-layout"

/** One full turn in 20 minutes: a few px a second at the graph's edge. */
export const TURN_RAD_PER_MS = (Math.PI * 2) / (20 * 60_000)
/** The mouse still this long and the graph starts turning. */
export const IDLE_MS = 1400
/** No input this long and it stops again (nobody is watching). */
export const IDLE_STOP_MS = 10 * 60_000
/** How long a repo's cards take to grow out of its circle. */
export const GROW_MS = 500
/** The loop's pace: about 15 frames a second is smooth at these speeds. */
export const FRAME_MS = 66

/** Every node but the repo turned by `theta` around the centre, in the rings' own (circular)
 *  space: the layout stays itself, cards stay upright. */
export function turned(nodes: FleetNode[], theta: number): FleetNode[] {
  if (!theta) return nodes
  const c = Math.cos(theta)
  const s = Math.sin(theta)
  return nodes.map((n) => {
    if (n.kind === "root") return n
    const u = (n.x - FLEET.cx) / FLEET.ex
    const v = n.y - FLEET.cy
    return { ...n, x: FLEET.cx + (u * c - v * s) * FLEET.ex, y: FLEET.cy + u * s + v * c }
  })
}

/** Nodes on their way out of the repo's circle: `k` from 0 (all at the centre) to 1 (placed). */
export function grown(nodes: FleetNode[], k: number): FleetNode[] {
  if (k >= 1) return nodes
  const e = 1 - (1 - Math.max(0, k)) ** 3 // ease out
  return nodes.map((n) =>
    n.kind === "root"
      ? n
      : { ...n, x: FLEET.cx + (n.x - FLEET.cx) * e, y: FLEET.cy + (n.y - FLEET.cy) * e },
  )
}

/** A dot's place on an edge, from its child to its parent: `phase` spaces a line's dots apart. */
export function dotAt(
  child: { x: number; y: number },
  parent: { x: number; y: number },
  ms: number,
  phase: number,
): { x: number; y: number } {
  const t = (ms / 2400 + phase) % 1 // one trip in 2.4 s
  return { x: child.x + (parent.x - child.x) * t, y: child.y + (parent.y - child.y) * t }
}

export interface MotionState {
  open: boolean // a repo is open (the overview never turns)
  shown: boolean // the window is visible and focused
  reduced: boolean // prefers-reduced-motion
  hovered: boolean // the pointer is on a card
  sinceInput: number // ms since the last mouse, wheel or key input
  working: boolean // an agent or sub-agent on screen is working (dots)
  growing: boolean // a repo's cards are still growing out
}

/** Whether the graph turns now. */
export const turning = (m: MotionState) =>
  m.open &&
  m.shown &&
  !m.reduced &&
  !m.hovered &&
  m.sinceInput >= IDLE_MS &&
  m.sinceInput < IDLE_STOP_MS

/** Whether the loop has anything to do: when not, it stops (and costs nothing). */
export const moving = (m: MotionState) =>
  m.shown && (turning(m) || (!m.reduced && (m.working || m.growing)))
