import { describe, it, expect } from "vitest"
import {
  GROW_MS,
  IDLE_MS,
  IDLE_STOP_MS,
  KEY_RAD,
  TURN_RAD_PER_MS,
  between,
  dotAt,
  grown,
  moving,
  turning,
  withPins,
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

describe("the turn", () => {
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

describe("keyframes", () => {
  it("one a second; a blend between two neighbours never overlaps and moves a little a frame", () => {
    expect(KEY_RAD).toBeCloseTo(TURN_RAD_PER_MS * 1000)
    for (let a = 0; a < 24; a++) {
      const x = relax(openLayout(busy, a * KEY_RAD * 50))
      const y = relax(openLayout(busy, (a * 50 + 1) * KEY_RAD))
      let prev = x
      for (let f = 1; f <= 15; f++) {
        const t = between(x, y, f / 15)
        for (let i = 0; i < t.length; i++) {
          expect(Math.hypot(t[i]!.x - prev[i]!.x, t[i]!.y - prev[i]!.y)).toBeLessThan(2)
          for (let j = i + 1; j < t.length; j++)
            expect(overlaps(t[i]!, t[j]!), `${a} ${f}: ${t[i]!.id} / ${t[j]!.id}`).toBe(false)
        }
        prev = t
      }
    }
  })

  it("its ends are the keyframes themselves; another node set is the newer one", () => {
    const x = relax(openLayout(busy))
    const y = relax(openLayout(busy, KEY_RAD))
    expect(between(x, y, 0)).toBe(x)
    expect(between(x, y, 1)).toBe(y)
    expect(between(x, y.slice(1), 0.5)).toEqual(y.slice(1))
  })
})

describe("withPins", () => {
  it("a pinned PR takes its agents and their sub-agents along", () => {
    const ns = openLayout(busy)
    const pr = ns.find((n) => n.id === nodeId.pr("u/1"))!
    const out = withPins(ns, new Map([[pr.id, { x: pr.x + 400, y: pr.y - 50 }]]))
    const moved = (id: string) => {
      const a = ns.find((n) => n.id === id)!
      const b = out.find((n) => n.id === id)!
      return [Math.round(b.x - a.x), Math.round(b.y - a.y)]
    }
    expect(moved(pr.id)).toEqual([400, -50])
    expect(moved(nodeId.agent("a1"))).toEqual([400, -50])
    expect(moved(nodeId.sub("a1-s0"))).toEqual([400, -50])
    expect(moved(nodeId.agent("a2"))).toEqual([0, 0]) // another PR's
    expect(withPins(ns, new Map())).toBe(ns)
  })
})

describe("grown", () => {
  it("starts at the repo and ends placed", () => {
    const ns = relax(openLayout(busy))
    const at0 = grown(ns, 0)
    const pr = at0.find((n) => n.id === nodeId.pr("u/1"))!
    expect([pr.x, pr.y]).toEqual([FLEET.cx, FLEET.cy])
    expect(grown(ns, 1)).toBe(ns)
    // (a card pinned mid-way stays under the pointer)
    expect(grown(ns, 0, new Set([pr.id])).find((n) => n.id === pr.id)).toBe(
      ns.find((n) => n.id === pr.id),
    )
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
    // dots stop too after a long idle (nobody is watching)
    expect(moving({ ...still, open: false, working: true, sinceInput: IDLE_STOP_MS + 1 })).toBe(
      false,
    )
  })
})
