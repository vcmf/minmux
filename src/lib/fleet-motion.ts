// The fleet graph's motion (docs/design/FLEET_GRAPH.md, "Motion"): the open repo's slow turn, the
// grow-out when it opens, the dots on working agents' edges, and when the loop may run at all.
// Pure; the view's one loop calls them.
import { FLEET, type FleetNode } from "./fleet-layout"

/** One full turn in 20 minutes: a few px a second at the graph's edge. */
export const TURN_RAD_PER_MS = (Math.PI * 2) / (20 * 60_000)
/** The mouse still this long and the graph starts turning. */
export const IDLE_MS = 1400
/** No input this long and it stops again (nobody is watching). */
export const IDLE_STOP_MS = 10 * 60_000
/** How long a repo's cards take to grow out of its circle. */
export const GROW_MS = 500
/** The turn's pace: about 15 frames a second is smooth at these speeds. */
export const FRAME_MS = 66

/** The turn's keyframes: one settled layout (with its overlap pass) a second; frames blend. */
export const KEY_MS = 1000
export const KEY_RAD = TURN_RAD_PER_MS * KEY_MS

/** Nodes on their way out of the repo's circle: `k` from 0 (all at the centre) to 1 (placed). */
export function grown(nodes: FleetNode[], k: number, fixed?: ReadonlySet<string>): FleetNode[] {
  if (k >= 1) return nodes
  const e = 1 - (1 - Math.max(0, k)) ** 3 // ease out
  return nodes.map((n) =>
    n.kind === "root" || fixed?.has(n.id)
      ? n
      : { ...n, x: FLEET.cx + (n.x - FLEET.cx) * e, y: FLEET.cy + (n.y - FLEET.cy) * e },
  )
}

/** Two layouts of the same nodes blended (`k` 0 → `a`, 1 → `b`); a different node set → `b`. */
export function between(a: FleetNode[], b: FleetNode[], k: number): FleetNode[] {
  if (k <= 0) return a
  if (k >= 1 || a.length !== b.length) return b
  const out: FleetNode[] = []
  for (let i = 0; i < a.length; i++) {
    const p = a[i]!
    const q = b[i]!
    if (p.id !== q.id) return b
    out.push(
      p.x === q.x && p.y === q.y ? q : { ...q, x: p.x + (q.x - p.x) * k, y: p.y + (q.y - p.y) * k },
    )
  }
  return out
}

/** Pinned cards where they were left; everything under one (its agents, their subs) moves along. */
export function withPins(
  nodes: FleetNode[],
  pins: ReadonlyMap<string, { x: number; y: number }>,
): FleetNode[] {
  if (!pins.size) return nodes
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const shift = new Map<string, { dx: number; dy: number } | null>()
  const shiftOf = (n: FleetNode): { dx: number; dy: number } | null => {
    if (shift.has(n.id)) return shift.get(n.id)!
    shift.set(n.id, null) // (a cycle can't loop)
    const p = pins.get(n.id)
    // (a stacked PR hangs off its base PR, yet is a card of its own on the ring: it stays)
    const up = n.parent ? byId.get(n.parent) : undefined
    const parent = n.kind === "pr" && up?.kind === "pr" ? undefined : up
    const d = p ? { dx: p.x - n.x, dy: p.y - n.y } : parent ? shiftOf(parent) : null
    shift.set(n.id, d)
    return d
  }
  return nodes.map((n) => {
    const d = shiftOf(n)
    return d ? { ...n, x: n.x + d.dx, y: n.y + d.dy } : n
  })
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
  m.shown &&
  (turning(m) || (!m.reduced && (m.growing || (m.working && m.sinceInput < IDLE_STOP_MS))))
