import { describe, it, expect } from "vitest"
import {
  FLEET,
  fit,
  nodeId,
  openLayout,
  overviewLayout,
  relax,
  rootSize,
  type FleetNode,
} from "./fleet-layout"
import type { FleetAgent, FleetRepo } from "./fleet-model"

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
const pr = (n: number, agents: FleetAgent[]) => ({
  url: `u/${n}`,
  number: n,
  state: "open" as const,
  agents,
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
      branches: [{ name: "fix", agents: [agent("b1")] }],
      agents: [agent("d1")],
    })
    const ns = byId(openLayout(r))
    expect(ns.get(nodeId.branch("o/r", "fix"))!.kind).toBe("branch")
    expect(ns.get(nodeId.agent("d1"))!.parent).toBe(nodeId.root("o/r"))
  })
})

describe("relax", () => {
  it("leaves no two cards overlapping in a busy repo, the repo where it was, all in bounds", () => {
    const r = repo({
      prs: [
        pr(1, [agent("a", 2), agent("b"), agent("c")]),
        pr(2, [agent("d"), agent("e")]),
        pr(3, [agent("f")]),
      ],
      branches: [{ name: "x", agents: [agent("g")] }],
      agents: [agent("h")],
    })
    const ns = relax(openLayout(r)) // (the default the view uses)
    for (let i = 0; i < ns.length; i++)
      for (let j = i + 1; j < ns.length; j++)
        expect(overlaps(ns[i]!, ns[j]!), `${ns[i]!.id} / ${ns[j]!.id}`).toBe(false)
    expect(byId(ns).get(nodeId.root("o/r"))).toMatchObject({ x: FLEET.cx, y: FLEET.cy })
    const area = fit(ns)
    for (const n of area.nodes) {
      expect(n.x - n.w / 2).toBeGreaterThanOrEqual(0)
      expect(n.y + n.h / 2).toBeLessThanOrEqual(area.h)
    }
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
    const area = fit(relax(openLayout(r)))
    const ns = area.nodes
    let bad = 0
    for (let i = 0; i < ns.length; i++)
      for (let j = i + 1; j < ns.length; j++) if (overlaps(ns[i]!, ns[j]!)) bad++
    expect(bad).toBe(0)
    expect(area.w).toBeGreaterThan(FLEET.w) // the area grew (it scrolls)
  })
})
