import { describe, expect, it } from "vitest"
import { stripOverflow } from "./strip-overflow"

describe("stripOverflow", () => {
  it("no fades when everything fits", () => {
    expect(stripOverflow(0, 300, 300)).toEqual({ left: false, right: false })
    expect(stripOverflow(0, 200, 300)).toEqual({ left: false, right: false })
  })
  it("right fade only at the start of an overflowing strip", () => {
    expect(stripOverflow(0, 600, 300)).toEqual({ left: false, right: true })
  })
  it("both fades in the middle", () => {
    expect(stripOverflow(150, 600, 300)).toEqual({ left: true, right: true })
  })
  it("left fade only at the end", () => {
    expect(stripOverflow(300, 600, 300)).toEqual({ left: true, right: false })
  })
  it("ignores sub-pixel remainders", () => {
    expect(stripOverflow(0.5, 600.6, 300)).toEqual({ left: false, right: true })
    expect(stripOverflow(300.2, 600.6, 300)).toEqual({ left: true, right: false })
  })
})
