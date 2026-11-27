import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { SHOW_MS, useRemoteTyped } from "./remote-typed"

describe("useRemoteTyped", () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it("shows who typed for a while", () => {
    useRemoteTyped.getState().typed("p1", "iphone-15")
    expect(useRemoteTyped.getState().by).toEqual({ p1: "iphone-15" })
    vi.advanceTimersByTime(SHOW_MS - 1)
    useRemoteTyped.getState().typed("p1", "iphone-15") // again: the timer restarts
    vi.advanceTimersByTime(SHOW_MS - 1)
    expect(useRemoteTyped.getState().by.p1).toBe("iphone-15")
    vi.advanceTimersByTime(1)
    expect(useRemoteTyped.getState().by).toEqual({})
  })
})
