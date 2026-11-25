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
  branch: [270, 34] as const,
  agent: [224, 64] as const,
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
  return repos.map((r, i) => {
    const a = -Math.PI / 2 + (Math.PI * 2 * i) / Math.max(repos.length, 1)
    const s = rootSize(r)
    const one = repos.length === 1
    return {
      id: nodeId.root(r.key),
      kind: "root" as const,
      x: FLEET.cx + (one ? 0 : Math.cos(a) * FLEET.ringRx),
      y: FLEET.cy + (one ? 0 : Math.sin(a) * FLEET.ringRy),
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
  type Child = { id: string; kind: "pr" | "branch" | "agent"; agents: FleetRepo["agents"] }
  const children: Child[] = [
    ...repo.prs.map((p) => ({ id: nodeId.pr(p.url), kind: "pr" as const, agents: p.agents })),
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
  const k = total <= 3 ? 0.8 : 1 // a small repo: smaller rings
  const r1 = FLEET.r1 * k
  const r2 = FLEET.r2 * k
  const unit = (Math.PI * 2) / total
  // The first slice centred at the top.
  let a = -Math.PI / 2 + theta - (weight(children[0]!) * unit) / 2
  const at = (r: number, ang: number) => ({
    x: FLEET.cx + Math.cos(ang) * r * FLEET.ex,
    y: FLEET.cy + Math.sin(ang) * r,
  })

  const placeAgent = (agent: FleetRepo["agents"][number], ang: number, parent: string) => {
    const p = at(r2, ang)
    const [w, h] = FLEET.agent
    out.push({ id: nodeId.agent(agent.id), kind: "agent", ...p, w, h, parent })
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
      const [w, h] = c.kind === "pr" ? FLEET.pr : FLEET.branch
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

/** Cards that overlap pushed apart along their shorter overlap (roots stay put), a few passes. */
export function relax(nodes: FleetNode[], passes = 4): FleetNode[] {
  const ns = nodes.map((n) => ({ ...n }))
  for (let pass = 0; pass < passes; pass++) {
    let moved = false
    for (let i = 0; i < ns.length; i++) {
      for (let j = i + 1; j < ns.length; j++) {
        const n = ns[i]!
        const m = ns[j]!
        const nf = n.kind === "root"
        const mf = m.kind === "root"
        if (nf && mf) continue
        const dx = m.x - n.x
        const dy = m.y - n.y
        const ox = (n.w + m.w) / 2 + 24 - Math.abs(dx)
        const oy = (n.h + m.h) / 2 + 20 - Math.abs(dy)
        if (ox <= 0 || oy <= 0) continue
        moved = true
        const wn = nf ? 0 : mf ? 1 : 0.5
        const wm = mf ? 0 : nf ? 1 : 0.5
        if (ox < oy) {
          const s = dx < 0 ? -1 : 1
          n.x -= s * ox * wn
          m.x += s * ox * wm
        } else {
          const s = dy < 0 ? -1 : 1
          n.y -= s * oy * wn
          m.y += s * oy * wm
        }
      }
    }
    if (!moved) break
  }
  for (const n of ns) {
    n.x = Math.max(n.w / 2 + 16, Math.min(FLEET.w - n.w / 2 - 16, n.x))
    n.y = Math.max(n.h / 2 + 16, Math.min(FLEET.h - n.h / 2 - 16, n.y))
  }
  return ns
}
