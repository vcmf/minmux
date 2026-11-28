import { describe, expect, it } from "vitest"
import { useDriven } from "./driven-store"

describe("driven store", () => {
  it("sets and clears, same reference when nothing changes", () => {
    useDriven.getState().set("a", "linux")
    expect(useDriven.getState().by).toEqual({ a: "linux" })
    const before = useDriven.getState().by
    useDriven.getState().set("a", "linux")
    expect(useDriven.getState().by).toBe(before)
    useDriven.getState().set("a", null)
    expect(useDriven.getState().by).toEqual({})
  })
})
