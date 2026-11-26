// The fleet graph's layout (docs/design/FLEET_GRAPH.md, "The graph"): the repos on a ring, or one
// repo opened as a radial tree. Each child of the repo (a PR, a branch with no PR, an agent on the
// default branch) gets a slice of the circle sized by the agents under it; PRs sit on an inner
// ring, agents on an outer ring inside their PR's slice and close to it, sub-agents just beyond
// their agent. `theta` turns every slice together (the motion step drives it). Pure.
import type { FleetRepo } from "./fleet-model"

export type FleetNodeKind = "root" | "pr" | "branch" | "agent" | "sub"

export interface FleetNode {
  id: string
  kind: FleetNodeKind
  x: number // centre, in the graph's own px (it scrolls)
  y: number
  w: number
  h: number
  parent?: string // the node it hangs off (its edge goes there)
  links?: string[] // an agent's other PRs / branches in the repo (an edge to each too)
}

/** The graph's area and its cards' sizes, in px. */
export const FLEET = {
  w: 2000,
  h: 1500,
  cx: 1000, // an open repo's centre
  cy: 770,
  ringRx: 290, // the overview's ring
  ringRy: 240,
  ex: 1.5, // rings are ellipses, wider than tall
  r1: 230, // PRs
  r2: 410, // agents
  r3: 110, // sub-agents, beyond their agent
  pr: [196, 56] as const,
  prDir: 74, // a PR checked out here: a third line, its folder
  branch: [270, 34] as const,
  agent: [236, 80] as const, // (three lines: name, what it does, folder · context · model)
  sub: [168, 28] as const,
}

export const nodeId = {
  root: (key: string) => `repo:${key}`,
  pr: (url: string) => `pr:${url}`,
  branch: (key: string, name: string) => `branch:${key}:${name}`,
  agent: (id: string) => `agent:${id}`,
  sub: (id: string) => `sub:${id}`,
}

/** A repo's circle: bigger with more live agents (capped). */
export const rootSize = (repo: FleetRepo) => Math.min(104, 64 + repo.counts.agents * 6)

/** Every repo on a ring, the first at the top, in the model's order. */
export function overviewLayout(repos: FleetRepo[]): FleetNode[] {
  // Room for each repo's 240px label around the ring: it grows (the camera's bounds follow it).
  const rx = Math.max(FLEET.ringRx, (repos.length * 340) / (Math.PI * 2))
  const ry = Math.max(FLEET.ringRy, rx * 0.85)
  return repos.map((r, i) => {
    const a = -Math.PI / 2 + (Math.PI * 2 * i) / Math.max(repos.length, 1)
    const s = rootSize(r)
    const one = repos.length === 1
    return {
      id: nodeId.root(r.key),
      kind: "root" as const,
      x: FLEET.cx + (one ? 0 : Math.cos(a) * rx),
      y: FLEET.cy + (one ? 0 : Math.sin(a) * ry),
      w: s,
      h: s,
    }
  })
}

const agentWeight = (subs: number) => (subs ? 1.4 : 1)

/** One repo opened: its root at the centre and everything under it on the rings. */
export function openLayout(repo: FleetRepo, theta = 0): FleetNode[] {
  const out: FleetNode[] = []
  const rootId = nodeId.root(repo.key)
  const s = rootSize(repo) + 8
  out.push({ id: rootId, kind: "root", x: FLEET.cx, y: FLEET.cy, w: s, h: s })

  // The repo's children, each with its agents (a direct agent is its own child).
  type Child = {
    id: string
    kind: "pr" | "branch" | "agent"
    agents: FleetRepo["agents"]
    dir?: boolean
  }
  const children: Child[] = [
    ...repo.prs.map((p) => ({
      id: nodeId.pr(p.url),
      kind: "pr" as const,
      agents: p.agents,
      dir: p.dirs.length > 0,
    })),
    ...repo.branches.map((b) => ({
      id: nodeId.branch(repo.key, b.name),
      kind: "branch" as const,
      agents: b.agents,
    })),
    ...repo.agents.map((a) => ({ id: nodeId.agent(a.id), kind: "agent" as const, agents: [a] })),
  ]
  if (!children.length) return out
  const weight = (c: Child) =>
    Math.max(
      1,
      c.agents.reduce((n, a) => n + agentWeight(a.subs.length), 0),
    )
  const total = children.reduce((n, c) => n + weight(c), 0)
  // A small repo: smaller rings; a busy one: bigger, so its agents keep a card's room each (the
  // area grows with it, `fit`).
  const k = total <= 3 ? 0.8 : Math.max(1, total * 0.095)
  const r1 = FLEET.r1 * k
  const r2 = FLEET.r2 * k
  const unit = (Math.PI * 2) / total
  // The first slice centred at the top.
  let a = -Math.PI / 2 + theta - (weight(children[0]!) * unit) / 2
  const at = (r: number, ang: number) => ({
    x: FLEET.cx + Math.cos(ang) * r * FLEET.ex,
    y: FLEET.cy + Math.sin(ang) * r,
  })

  // The PRs and branches each agent touches besides the one it hangs off.
  const links = new Map<string, string[]>()
  const link = (agents: FleetRepo["agents"], to: string) => {
    for (const a of agents) links.set(a.id, [...(links.get(a.id) ?? []), to])
  }
  for (const p of repo.prs) link(p.linked, nodeId.pr(p.url))
  for (const b of repo.branches) link(b.linked, nodeId.branch(repo.key, b.name))

  const placeAgent = (agent: FleetRepo["agents"][number], ang: number, parent: string) => {
    const p = at(r2, ang)
    const [w, h] = FLEET.agent
    const more = links.get(agent.id)
    out.push({
      id: nodeId.agent(agent.id),
      kind: "agent",
      ...p,
      w,
      h,
      parent,
      ...(more ? { links: more } : {}),
    })
    const m = agent.subs.length
    agent.subs.forEach((sub, j) => {
      const sa = ang + (j - (m - 1) / 2) * 0.45
      const [sw, sh] = FLEET.sub
      out.push({
        id: nodeId.sub(sub.id),
        kind: "sub",
        x: p.x + Math.cos(sa) * FLEET.r3 * 1.5,
        y: p.y + Math.sin(sa) * FLEET.r3,
        w: sw,
        h: sh,
        parent: nodeId.agent(agent.id),
      })
    })
  }

  for (const c of children) {
    const sec = weight(c) * unit
    const mid = a + sec / 2
    if (c.kind === "agent") placeAgent(c.agents[0]!, mid, rootId)
    else {
      const [w, h0] = c.kind === "pr" ? FLEET.pr : FLEET.branch
      const h = c.kind === "pr" && c.dir ? FLEET.prDir : h0
      out.push({ id: c.id, kind: c.kind, ...at(r1, mid), w, h, parent: rootId })
      // Its agents close to it: at most the slice, at least a card's width apart on screen.
      const tot = c.agents.reduce((n, ag) => n + agentWeight(ag.subs.length), 0)
      const span = Math.min(sec * 0.9, tot * Math.max(0.5, 280 / (r2 * FLEET.ex)))
      let b = mid - span / 2
      for (const ag of c.agents) {
        const step = (agentWeight(ag.subs.length) / tot) * span
        placeAgent(ag, b + step / 2, c.id)
        b += step
      }
    }
    a += sec
  }
  return out
}

type Pt = { x: number; y: number }

// Round the centre at the ends' mean ring (between the PRs' and the agents'), the short way.
/** A link edge's two control points: it never cuts through the root. */
export function linkCurve(a: Pt, b: Pt): [Pt, Pt] {
  const polar = (q: Pt) => {
    const dx = (q.x - FLEET.cx) / FLEET.ex
    const dy = q.y - FLEET.cy
    return { r: Math.hypot(dx, dy), t: Math.atan2(dy, dx) }
  }
  const pa = polar(a)
  const pb = polar(b)
  let d = pb.t - pa.t
  while (d > Math.PI) d -= Math.PI * 2
  while (d < -Math.PI) d += Math.PI * 2
  // (nearly opposite: the positive way round, the long way if need be; a nudge across π would
  // flip it to the other side of the root)
  if (d < -(Math.PI - 0.3)) d += Math.PI * 2
  // (a cubic's middle sits a quarter in from its control points: pushed out to make up for it)
  const r = ((pa.r + pb.r) / 2) * (1 + Math.abs(d) / 12)
  const at = (t: number) => ({
    x: FLEET.cx + Math.cos(t) * r * FLEET.ex,
    y: FLEET.cy + Math.sin(t) * r,
  })
  return [at(pa.t + d / 3), at(pa.t + (2 * d) / 3)]
}

/** A point on a cubic from `a` to `b` with control points `c`, at `t` in 0..1. */
export function cubicAt(a: Pt, [c1, c2]: [Pt, Pt], b: Pt, t: number): Pt {
  const u = 1 - t
  const k0 = u * u * u
  const k1 = 3 * u * u * t
  const k2 = 3 * u * t * t
  const k3 = t * t * t
  return {
    x: k0 * a.x + k1 * c1.x + k2 * c2.x + k3 * b.x,
    y: k0 * a.y + k1 * c1.y + k2 * c2.y + k3 * b.y,
  }
}

// Each overlapping pair is pushed apart along the line between their centres, by the least that
// clears them on either axis. That's continuous in the cards' positions (no axis choice that
// flips), so a layout turned a little moves its cards a little: it can run on every frame.
/** Cards that overlap pushed apart (roots stay put), until still. */
export function relax(nodes: FleetNode[], passes = 40, fixed?: Set<string>): FleetNode[] {
  const ns = nodes.map((n) => ({ ...n }))
  for (let pass = 0; pass < passes; pass++) {
    let moved = false
    for (let i = 0; i < ns.length; i++) {
      for (let j = i + 1; j < ns.length; j++) {
        const n = ns[i]!
        const m = ns[j]!
        const nf = n.kind === "root" || !!fixed?.has(n.id)
        const mf = m.kind === "root" || !!fixed?.has(m.id)
        if (nf && mf) continue
        const dx = m.x - n.x
        const dy = m.y - n.y
        const gx = (n.w + m.w) / 2 + 24 // the gaps that keep them apart, per axis
        const gy = (n.h + m.h) / 2 + 20
        if (Math.abs(dx) >= gx || Math.abs(dy) >= gy) continue
        moved = true
        const d = Math.hypot(dx, dy)
        const ux = d > 1e-6 ? dx / d : 0
        const uy = d > 1e-6 ? dy / d : 1
        // how far along (ux, uy) until one axis clears
        const tx = Math.abs(ux) > 1e-6 ? (gx - Math.abs(dx)) / Math.abs(ux) : Infinity
        const ty = Math.abs(uy) > 1e-6 ? (gy - Math.abs(dy)) / Math.abs(uy) : Infinity
        const t = Math.min(tx, ty)
        const wn = nf ? 0 : mf ? 1 : 0.5
        const wm = mf ? 0 : nf ? 1 : 0.5
        n.x -= ux * t * wn
        n.y -= uy * t * wn
        m.x += ux * t * wm
        m.y += uy * t * wm
      }
    }
    if (!moved) break
  }
  return ns
}

/** The camera: the world point shown in the middle of the view. */
export interface Camera {
  x: number
  y: number
}

/** The graph's extent: the box every card (and a root's label) fits in. */
export function bounds(nodes: FleetNode[]): { x0: number; y0: number; x1: number; y1: number } {
  if (!nodes.length) return { x0: FLEET.cx, y0: FLEET.cy, x1: FLEET.cx, y1: FLEET.cy }
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (const n of nodes) {
    const half = n.kind === "root" ? Math.max(n.w, 240) / 2 : n.w / 2 // (a root's label)
    x0 = Math.min(x0, n.x - half)
    y0 = Math.min(y0, n.y - n.h / 2)
    x1 = Math.max(x1, n.x + half)
    y1 = Math.max(y1, n.y + n.h / 2 + (n.kind === "root" ? 60 : 0))
  }
  return { x0, y0, x1, y1 }
}

type Box = { x0: number; y0: number; x1: number; y1: number }

/** Two extents as one (a view's extent only grows while it shows: the camera never snaps in). */
export const unionBox = (a: Box | null, b: Box): Box =>
  a
    ? {
        x0: Math.min(a.x0, b.x0),
        y0: Math.min(a.y0, b.y0),
        x1: Math.max(a.x1, b.x1),
        y1: Math.max(a.y1, b.y1),
      }
    : b

/** A camera kept over the graph: its middle never leaves the extent (the nodes', or `box`). */
export function clampCamera(c: Camera, nodes: FleetNode[], box?: Box): Camera {
  const b = box ?? bounds(nodes)
  return {
    x: Math.min(b.x1, Math.max(b.x0, c.x)),
    y: Math.min(b.y1, Math.max(b.y0, c.y)),
  }
}

/** Where a world point lands on screen, for a camera and a view size. */
export const toScreen = (p: Camera, c: Camera, w: number, h: number) => ({
  x: p.x - c.x + w / 2,
  y: p.y - c.y + h / 2,
})
