import { describe, it, expect } from "vitest"
import {
  FLEET,
  bounds,
  cubicAt,
  edgeEnd,
  linkCurve,
  clampCamera,
  unionBox,
  toScreen,
  nodeId,
  openLayout,
  overviewLayout,
  relax,
  rootSize,
  type FleetNode,
} from "./fleet-layout"
import type { FleetAgent, FleetPr, FleetRepo } from "./fleet-model"

const agent = (id: string, subs = 0): FleetAgent => ({
  id,
  sessionId: id,
  paneId: `p-${id}`,
  kind: "claude",
  status: "working",
  subs: Array.from({ length: subs }, (_, i) => ({
    id: `${id}-s${i}`,
    type: "Explore",
    status: "working" as const,
  })),
})
const repo = (over: Partial<FleetRepo> = {}): FleetRepo => ({
  key: "o/r",
  label: "o/r",
  prs: [],
  branches: [],
  agents: [],
  counts: { agents: 0, working: 0, waiting: 0, prs: 0 },
  roots: [],
  ...over,
})
const pr = (n: number, agents: FleetAgent[], linked: FleetAgent[] = []): FleetPr => ({
  url: `u/${n}`,
  number: n,
  state: "open" as const,
  agents,
  linked,
  dirs: [],
})
const byId = (ns: FleetNode[]) => new Map(ns.map((n) => [n.id, n]))
const dist = (n: FleetNode) => Math.hypot((n.x - FLEET.cx) / FLEET.ex, n.y - FLEET.cy)
const overlaps = (a: FleetNode, b: FleetNode) =>
  Math.abs(a.x - b.x) < (a.w + b.w) / 2 && Math.abs(a.y - b.y) < (a.h + b.h) / 2

describe("overviewLayout", () => {
  it("puts the repos on a ring, the first at the top; one repo sits at the centre", () => {
    const ns = overviewLayout([repo({ key: "a" }), repo({ key: "b" }), repo({ key: "c" })])
    expect(ns).toHaveLength(3)
    expect(ns[0]!.x).toBeCloseTo(FLEET.cx)
    expect(ns[0]!.y).toBeLessThan(FLEET.cy)
    const one = overviewLayout([repo()])
    expect([one[0]!.x, one[0]!.y]).toEqual([FLEET.cx, FLEET.cy])
  })

  it("the ring grows with the repos, so their labels don't overlap", () => {
    const ns = overviewLayout(Array.from({ length: 10 }, (_, i) => repo({ key: `r${i}` })))
    for (let i = 0; i < ns.length; i++) {
      const a = ns[i]!
      const b = ns[(i + 1) % ns.length]!
      expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThan(240) // a label's width
    }
  })

  it("a repo's circle grows with its agents, up to a cap", () => {
    expect(rootSize(repo())).toBe(64)
    expect(rootSize(repo({ counts: { agents: 3, working: 0, waiting: 0, prs: 0 } }))).toBe(82)
    expect(rootSize(repo({ counts: { agents: 30, working: 0, waiting: 0, prs: 0 } }))).toBe(104)
  })
})

describe("openLayout", () => {
  it("an agent on two PRs hangs off its own, linked to the other", () => {
    const a = agent("a1")
    const ns = byId(openLayout(repo({ prs: [pr(7, [a]), pr(9, [], [a])] })))
    const n = ns.get(nodeId.agent("a1"))!
    expect(n.parent).toBe(nodeId.pr("u/7"))
    expect(n.links).toEqual([nodeId.pr("u/9")])
    expect(ns.get(nodeId.pr("u/7"))!.h).toBe(FLEET.pr[1]) // (no checkout here: two lines)
    const withDir = byId(openLayout(repo({ prs: [{ ...pr(7, [a]), dirs: ["/w/x"] }] })))
    expect(withDir.get(nodeId.pr("u/7"))!.h).toBe(FLEET.prDir)
    expect(withDir.get(nodeId.agent("a1"))!.links).toBeUndefined()
  })

  it("a stacked PR hangs off the PR it's on, not the root", () => {
    const top = { ...pr(9, []), on: { url: "u/7", number: 7 } }
    const ns = byId(openLayout(repo({ prs: [pr(7, [agent("a1")]), top] })))
    expect(ns.get(nodeId.pr("u/9"))!.parent).toBe(nodeId.pr("u/7"))
    expect(ns.get(nodeId.pr("u/7"))!.parent).toBe(nodeId.root("o/r"))
  })

  it("one PR with two agents: the PR above the repo, its agents further out, each edge to its parent", () => {
    const r = repo({ prs: [pr(7, [agent("a1"), agent("a2")])] })
    const ns = byId(openLayout(r))
    const root = ns.get(nodeId.root("o/r"))!
    const p = ns.get(nodeId.pr("u/7"))!
    expect([root.x, root.y]).toEqual([FLEET.cx, FLEET.cy])
    expect(p.y).toBeLessThan(root.y) // the first slice at the top
    expect(p.parent).toBe(root.id)
    for (const id of ["a1", "a2"]) {
      const a = ns.get(nodeId.agent(id))!
      expect(a.parent).toBe(p.id)
      expect(dist(a)).toBeGreaterThan(dist(p))
    }
  })

  it("sub-agents sit beyond their agent", () => {
    const ns = byId(openLayout(repo({ agents: [agent("a1", 2)] })))
    const a = ns.get(nodeId.agent("a1"))!
    for (const s of ["a1-s0", "a1-s1"]) {
      const n = ns.get(nodeId.sub(s))!
      expect(n.parent).toBe(a.id)
      expect(dist(n)).toBeGreaterThan(dist(a))
    }
  })

  it("theta turns every slice together, the repo stays", () => {
    const r = repo({ prs: [pr(1, [agent("a")]), pr(2, [agent("b")])] })
    const before = byId(openLayout(r, 0))
    const after = byId(openLayout(r, Math.PI / 2))
    expect(after.get(nodeId.root("o/r"))).toEqual(before.get(nodeId.root("o/r")))
    for (const id of [nodeId.pr("u/1"), nodeId.agent("a")]) {
      const b = before.get(id)!
      const a = after.get(id)!
      const ang = (n: FleetNode) => Math.atan2(n.y - FLEET.cy, (n.x - FLEET.cx) / FLEET.ex)
      const turn = (ang(a) - ang(b) + Math.PI * 2) % (Math.PI * 2)
      expect(turn).toBeCloseTo(Math.PI / 2, 5)
    }
  })

  it("a small repo uses smaller rings", () => {
    const small = byId(openLayout(repo({ prs: [pr(1, [agent("a")])] })))
    const big = byId(
      openLayout(repo({ prs: [pr(1, [agent("a"), agent("b"), agent("c"), agent("d")])] })),
    )
    expect(dist(small.get(nodeId.pr("u/1"))!)).toBeLessThan(dist(big.get(nodeId.pr("u/1"))!))
  })

  it("branches and agents on the default branch get slices too", () => {
    const r = repo({
      branches: [{ name: "fix", agents: [agent("b1")], linked: [], dirs: [] }],
      agents: [agent("d1")],
    })
    const ns = byId(openLayout(r))
    expect(ns.get(nodeId.branch("o/r", "fix"))!.kind).toBe("branch")
    expect(ns.get(nodeId.agent("d1"))!.parent).toBe(nodeId.root("o/r"))
  })
})

describe("relax", () => {
  it("leaves no two cards overlapping in a busy repo, the repo where it was", () => {
    const r = repo({
      prs: [
        pr(1, [agent("a", 2), agent("b"), agent("c")]),
        pr(2, [agent("d"), agent("e")]),
        pr(3, [agent("f")]),
      ],
      branches: [{ name: "x", agents: [agent("g")], linked: [], dirs: [] }],
      agents: [agent("h")],
    })
    const ns = relax(openLayout(r)) // (the default the view uses)
    for (let i = 0; i < ns.length; i++)
      for (let j = i + 1; j < ns.length; j++)
        expect(overlaps(ns[i]!, ns[j]!), `${ns[i]!.id} / ${ns[j]!.id}`).toBe(false)
    expect(byId(ns).get(nodeId.root("o/r"))).toMatchObject({ x: FLEET.cx, y: FLEET.cy })
  })

  it("a very busy repo (8 PRs × 4 agents × 3 sub-agents) still has no overlaps", () => {
    let n = 0
    const r = repo({
      prs: Array.from({ length: 8 }, (_, i) =>
        pr(
          i,
          Array.from({ length: 4 }, () => agent(`a${n++}`, 3)),
        ),
      ),
    })
    const ns = relax(openLayout(r))
    let bad = 0
    for (let i = 0; i < ns.length; i++)
      for (let j = i + 1; j < ns.length; j++) if (overlaps(ns[i]!, ns[j]!)) bad++
    expect(bad).toBe(0)
  })
})

describe("camera", () => {
  const node = (id: string, x: number, y: number): FleetNode => ({
    id,
    kind: "agent",
    x,
    y,
    w: 100,
    h: 40,
  })

  it("stays over the graph: its middle is clamped to the graph's extent", () => {
    const ns = [node("a", 0, 0), node("b", 1000, 600)]
    expect(clampCamera({ x: 500, y: 300 }, ns)).toEqual({ x: 500, y: 300 })
    expect(clampCamera({ x: -5000, y: 9000 }, ns)).toEqual({ x: -50, y: 620 })
  })

  it("puts the world point it holds in the middle of the view, whatever the view's size", () => {
    const cam = { x: 700, y: 400 }
    expect(toScreen(cam, cam, 1200, 800)).toEqual({ x: 600, y: 400 })
    expect(toScreen(cam, cam, 900, 500)).toEqual({ x: 450, y: 250 }) // a resize keeps it centred
    expect(toScreen({ x: 800, y: 400 }, cam, 1200, 800)).toEqual({ x: 700, y: 400 })
  })

  it("within a view the camera's bounds only grow: a card going away never pulls it in", () => {
    const big = [node("a", 0, 0), node("far", 3000, 0)]
    const small = [node("a", 0, 0)]
    const box = unionBox(bounds(big), bounds(small))
    expect(clampCamera({ x: 2900, y: 0 }, small, box).x).toBe(2900) // still reachable
    expect(clampCamera({ x: 2900, y: 0 }, small).x).toBe(50) // (without the kept extent)
  })
})

describe("edgeEnd", () => {
  it("stops at the card's border, heading into it", () => {
    const b = { x: 300, y: 100, w: 100, h: 40 }
    const line = edgeEnd({ x: 0, y: 100 }, undefined, b)!
    expect(line.x).toBeCloseTo(250, 1)
    expect(line.y).toBeCloseTo(100)
    expect(line.angle).toBeCloseTo(0)
    // a curve: on the border too, heading inwards
    const a = { x: FLEET.cx - 400, y: FLEET.cy - 200 }
    const to = { x: FLEET.cx + 300, y: FLEET.cy - 230, w: 196, h: 56 }
    const end = edgeEnd(a, linkCurve(a, to), to)!
    const onEdge =
      Math.abs(Math.abs(end.x - to.x) - to.w / 2) < 0.5 ||
      Math.abs(Math.abs(end.y - to.y) - to.h / 2) < 0.5
    expect(onEdge).toBe(true)
    expect(edgeEnd({ x: 310, y: 105 }, undefined, b)).toBeNull() // (starting on the card)
    expect(
      Math.cos(end.angle) * (to.x - end.x) + Math.sin(end.angle) * (to.y - end.y),
    ).toBeGreaterThan(0)
  })
})

describe("linkCurve", () => {
  it("goes round the centre, never through it, ends to ends", () => {
    const a = { x: FLEET.cx, y: FLEET.cy - 400 } // top
    const b = { x: FLEET.cx, y: FLEET.cy + 230 } // bottom, an inner ring
    const c = linkCurve(a, b)
    expect(cubicAt(a, c, b, 0)).toEqual(a)
    expect(cubicAt(a, c, b, 1)).toEqual(b)
    const mid = cubicAt(a, c, b, 0.5)
    expect(Math.hypot((mid.x - FLEET.cx) / FLEET.ex, mid.y - FLEET.cy)).toBeGreaterThan(230)
    // neighbours: a gentle bend, close to the straight line
    const n = { x: FLEET.cx + 50, y: FLEET.cy - 400 }
    const m = cubicAt(a, linkCurve(a, n), n, 0.5)
    expect(Math.abs(m.y - (FLEET.cy - 400))).toBeLessThan(5)
    // nearly opposite: the same side whichever way a nudge tips it, never inside the PR ring
    const r = { x: FLEET.cx + 400 * FLEET.ex, y: FLEET.cy }
    const midOf = (ang: number) => {
      const l = { x: FLEET.cx + Math.cos(ang) * 230 * FLEET.ex, y: FLEET.cy + Math.sin(ang) * 230 }
      return cubicAt(r, linkCurve(r, l), l, 0.5)
    }
    const sides = [Math.PI - 0.1, -(Math.PI - 0.1), Math.PI - 0.25, -(Math.PI - 0.25)].map((a) =>
      Math.sign(midOf(a).y - FLEET.cy),
    )
    expect(new Set(sides).size).toBe(1)
    for (const a of [-(Math.PI - 0.29), -(Math.PI - 0.31), Math.PI - 0.05]) {
      const m = midOf(a)
      expect(Math.hypot((m.x - FLEET.cx) / FLEET.ex, m.y - FLEET.cy)).toBeGreaterThan(230)
    }
  })
})
