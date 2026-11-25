import { describe, it, expect } from "vitest"
import { cardInView, keyPan, wheelPan } from "./fleet-camera"
import type { FleetNode } from "./fleet-layout"

const wheel = (over: Partial<Parameters<typeof wheelPan>[0]> = {}) => ({
  deltaX: 0,
  deltaY: 0,
  deltaMode: 0,
  shiftKey: false,
  ctrlKey: false,
  ...over,
})
const key = (k: string, over: Partial<Parameters<typeof keyPan>[0]> = {}) => ({
  key: k,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  ...over,
})

const page = { w: 1600, h: 800 }

describe("wheelPan", () => {
  it("pans by pixels, lines and pages", () => {
    expect(wheelPan(wheel({ deltaX: 5, deltaY: 10 }), page)).toEqual({ dx: 5, dy: 10 })
    expect(wheelPan(wheel({ deltaY: 3, deltaMode: 1 }), page)).toEqual({ dx: 0, dy: 48 })
    expect(wheelPan(wheel({ deltaY: 1, deltaMode: 2 }), page)).toEqual({ dx: 0, dy: 800 })
    // (a page sideways is the view's width)
    expect(wheelPan(wheel({ deltaY: 1, deltaMode: 2, shiftKey: true }), page)).toEqual({
      dx: 1600,
      dy: 0,
    })
  })

  it("shift turns a mouse wheel sideways; a trackpad's own sideways stays", () => {
    expect(wheelPan(wheel({ deltaY: 40, shiftKey: true }), page)).toEqual({ dx: 40, dy: 0 })
    expect(wheelPan(wheel({ deltaX: 7, deltaY: 3, shiftKey: true }), page)).toEqual({
      dx: 7,
      dy: 3,
    })
  })

  it("a pinch (ctrl wheel) is no pan", () => {
    expect(wheelPan(wheel({ deltaY: 10, ctrlKey: true }), page)).toBeNull()
  })
})

describe("keyPan", () => {
  it("arrows step, Page Up/Down most of a screen, Home goes back to the centre", () => {
    expect(keyPan(key("ArrowRight"), 1000)).toEqual({ dx: 80, dy: 0 })
    expect(keyPan(key("ArrowUp"), 1000)).toEqual({ dx: 0, dy: -80 })
    expect(keyPan(key("PageDown"), 1000)).toEqual({ dx: 0, dy: 800 })
    expect(keyPan(key("Home"), 1000)).toBe("home")
  })

  it("leaves modified keys and other keys alone", () => {
    expect(keyPan(key("ArrowLeft", { metaKey: true }), 1000)).toBeNull()
    expect(keyPan(key("ArrowDown", { altKey: true }), 1000)).toBeNull()
    expect(keyPan(key("a"), 1000)).toBeNull()
  })
})

describe("cardInView", () => {
  const card: FleetNode = { id: "c", kind: "pr", x: 0, y: 0, w: 200, h: 60 }
  const view = { w: 1000, h: 800, top: 0 }

  it("a card in the middle is in view; one past an edge isn't", () => {
    expect(cardInView(card, { x: 0, y: 0 }, view)).toBe(true)
    expect(cardInView(card, { x: 450, y: 0 }, view)).toBe(false) // its left edge past the left side
  })

  it("a repo circle counts with its label below it", () => {
    const root: FleetNode = { id: "r", kind: "root", x: 0, y: 0, w: 80, h: 80 }
    // the circle's bottom 40px above the view's bottom margin, its label not
    expect(cardInView(root, { x: 0, y: -280 }, view)).toBe(false)
    expect(cardInView(root, { x: 0, y: -200 }, view)).toBe(true)
  })

  it("a card under the dock of other repos isn't in view", () => {
    const nearTop = { x: 0, y: 360 } // the card's top 10px below the view's top
    expect(cardInView(card, nearTop, { ...view, top: 0 }, 0)).toBe(true)
    expect(cardInView(card, nearTop, { ...view, top: 48 }, 0)).toBe(false)
  })
})
