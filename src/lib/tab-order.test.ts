import { describe, it, expect } from "vitest"
import { moveTo, insertIndexAt } from "./tab-order"

const L = ["a", "b", "c", "d"].map((id) => ({ id }))
const ids = (xs: { id: string }[]) => xs.map((x) => x.id).join("")

describe("moveTo", () => {
  it("moves forward and backward to the insertion point", () => {
    expect(ids(moveTo(L, "a", 3))).toBe("bcad") // before d
    expect(ids(moveTo(L, "a", 4))).toBe("bcda") // at the end
    expect(ids(moveTo(L, "d", 0))).toBe("dabc")
    expect(ids(moveTo(L, "c", 1))).toBe("acbd")
  })
  it("dropping right before or after itself (or an unknown id) is a no-op — same array", () => {
    expect(moveTo(L, "b", 1)).toBe(L)
    expect(moveTo(L, "b", 2)).toBe(L)
    expect(moveTo(L, "zz", 0)).toBe(L)
  })
  it("clamps an out-of-range index", () => {
    expect(ids(moveTo(L, "a", 99))).toBe("bcda")
    expect(ids(moveTo(L, "d", -3))).toBe("dabc")
  })
})

describe("insertIndexAt", () => {
  const spans: [number, number][] = [
    [0, 100],
    [100, 200],
    [200, 300],
  ]
  it("before the first item whose midpoint is past the pointer", () => {
    expect(insertIndexAt(spans, 10)).toBe(0)
    expect(insertIndexAt(spans, 60)).toBe(1)
    expect(insertIndexAt(spans, 149)).toBe(1)
    expect(insertIndexAt(spans, 151)).toBe(2)
    expect(insertIndexAt(spans, 290)).toBe(3)
    expect(insertIndexAt([], 5)).toBe(0)
  })
})
