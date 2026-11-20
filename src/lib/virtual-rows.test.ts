import { describe, it, expect } from "vitest"
import { rowWindow } from "./virtual-rows"

describe("rowWindow", () => {
  it("a short list renders whole", () => {
    expect(rowWindow(100, 28, 500, 300)).toEqual({ start: 0, end: 100 })
  })

  it("a long list renders the rows in view plus the margin", () => {
    // 28px rows, 280px viewport scrolled to row 100: rows 100..110 in view, ±20.
    expect(rowWindow(5000, 28, 2800, 280, 300, 20)).toEqual({ start: 80, end: 130 })
  })

  it("clamps at both ends", () => {
    expect(rowWindow(5000, 28, 0, 280, 300, 20)).toEqual({ start: 0, end: 30 })
    expect(rowWindow(400, 28, 400 * 28, 280, 300, 20)).toEqual({ start: 380, end: 400 })
  })

  it("an unmeasured viewport still renders at least a row's worth", () => {
    expect(rowWindow(1000, 28, 0, 0, 300, 0)).toEqual({ start: 0, end: 1 })
  })
})
