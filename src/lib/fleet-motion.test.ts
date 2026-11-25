import { describe, it, expect } from "vitest"
import {
  GROW_MS,
  IDLE_MS,
  IDLE_STOP_MS,
  TURN_RAD_PER_MS,
  dotAt,
  grown,
  moving,
  turned,
  turning,
  type MotionState,
} from "./fleet-motion"
import { FLEET, nodeId, openLayout, relax, type FleetNode } from "./fleet-layout"
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
const busy: FleetRepo = {
  key: "o/r",
  label: "o/r",
  prs: [1, 2, 3].map((n) => ({
    url: `u/${n}`,
    number: n,
    state: "open" as const,
    agents: [agent(`a${n}`, 2), agent(`b${n}`), agent(`c${n}`)],
  })),
  branches: [{ name: "x", agents: [agent("g")] }],
  agents: [agent("h")],
  counts: { agents: 11, working: 11, waiting: 0, prs: 3 },
  roots: [],
}
const overlaps = (a: FleetNode, b: FleetNode) =>
  Math.abs(a.x - b.x) < (a.w + b.w) / 2 && Math.abs(a.y - b.y) < (a.h + b.h) / 2

describe("turned", () => {
  it("turns every node but the repo, keeping their distance in the rings' space", () => {
    const ns = relax(openLayout(busy))
    const t = turned(ns, 1)
    const r = (n: FleetNode) => Math.hypot((n.x - FLEET.cx) / FLEET.ex, n.y - FLEET.cy)
    for (let i = 0; i < ns.length; i++) {
      if (ns[i]!.kind === "root") expect(t[i]).toBe(ns[i])
      else expect(r(t[i]!)).toBeCloseTo(r(ns[i]!), 6)
    }
  })

  it("a full turn comes back to where it started", () => {
    const ns = relax(openLayout(busy))
    turned(ns, Math.PI * 2).forEach((n, i) => {
      expect(n.x).toBeCloseTo(ns[i]!.x, 6)
      expect(n.y).toBeCloseTo(ns[i]!.y, 6)
    })
  })

  it("laid out at any angle of the turn, no two cards overlap (a busy repo)", () => {
    for (let a = 0; a < 24; a++) {
      const t = relax(openLayout(busy, (Math.PI * 2 * a) / 24))
      for (let i = 0; i < t.length; i++)
        for (let j = i + 1; j < t.length; j++)
          expect(overlaps(t[i]!, t[j]!), `angle ${a}: ${t[i]!.id} / ${t[j]!.id}`).toBe(false)
    }
  })

  it("a small turn moves the cards a little: no jumps from one frame to the next", () => {
    for (let a = 0; a < 48; a++) {
      const th = (Math.PI * 2 * a) / 48
      const x = relax(openLayout(busy, th))
      const y = relax(openLayout(busy, th + TURN_RAD_PER_MS * 66)) // one frame's turn
      x.forEach((n, i) => {
        expect(Math.hypot(n.x - y[i]!.x, n.y - y[i]!.y), `${n.id} at ${a}`).toBeLessThan(2)
      })
    }
  })

  it("is slow: a few px a second at the graph's edge", () => {
    const pxPerSec = TURN_RAD_PER_MS * 1000 * 410 * FLEET.ex
    expect(pxPerSec).toBeGreaterThan(1)
    expect(pxPerSec).toBeLessThan(5)
  })
})

describe("grown", () => {
  it("starts at the repo and ends placed", () => {
    const ns = relax(openLayout(busy))
    const at0 = grown(ns, 0)
    const pr = at0.find((n) => n.id === nodeId.pr("u/1"))!
    expect([pr.x, pr.y]).toEqual([FLEET.cx, FLEET.cy])
    expect(grown(ns, 1)).toBe(ns)
    expect(GROW_MS).toBeGreaterThan(0)
  })
})

describe("dotAt", () => {
  it("runs from the child to its parent, and comes round again", () => {
    const c = { x: 0, y: 0 }
    const p = { x: 100, y: 0 }
    expect(dotAt(c, p, 0, 0)).toEqual({ x: 0, y: 0 })
    expect(dotAt(c, p, 1200, 0).x).toBeCloseTo(50)
    expect(dotAt(c, p, 2400, 0).x).toBeCloseTo(0)
    expect(dotAt(c, p, 0, 0.5).x).toBeCloseTo(50) // a second dot, half a trip behind
  })
})

describe("the loop's rules", () => {
  const still: MotionState = {
    open: true,
    shown: true,
    reduced: false,
    hovered: false,
    sinceInput: IDLE_MS + 1,
    working: false,
    growing: false,
  }

  it("turns an open repo once the mouse has been still a moment", () => {
    expect(turning(still)).toBe(true)
    expect(turning({ ...still, sinceInput: 200 })).toBe(false) // moving the mouse
    expect(turning({ ...still, open: false })).toBe(false) // the overview never turns
  })

  it("stops for a hover, reduced motion, a hidden window, and a long idle", () => {
    expect(turning({ ...still, hovered: true })).toBe(false)
    expect(turning({ ...still, reduced: true })).toBe(false)
    expect(turning({ ...still, shown: false })).toBe(false)
    expect(turning({ ...still, sinceInput: IDLE_STOP_MS + 1 })).toBe(false)
  })

  it("the loop runs only while something moves", () => {
    expect(moving({ ...still, sinceInput: 0 })).toBe(false) // settled, nothing working
    expect(moving({ ...still, sinceInput: 0, working: true })).toBe(true) // dots
    expect(moving({ ...still, sinceInput: 0, working: true, reduced: true })).toBe(false)
    expect(moving({ ...still, working: true, shown: false })).toBe(false) // hidden: nothing
    expect(moving({ ...still, sinceInput: 0, growing: true })).toBe(true)
  })
})
