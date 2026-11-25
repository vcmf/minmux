import { describe, it, expect, vi, afterEach } from "vitest"
import { act, renderHook } from "@testing-library/react"
import { useThrottled } from "./use-fleet-data"

afterEach(() => vi.useRealTimers())

describe("useThrottled", () => {
  it("follows a fast-changing value at most once per window, ending on the latest", () => {
    vi.useFakeTimers()
    vi.setSystemTime(10_000)
    const { result, rerender } = renderHook(({ v }) => useThrottled(v, 1000), {
      initialProps: { v: 0 },
    })
    expect(result.current).toBe(0)
    // Ten updates within one window (as tool calls move the agent graph): the first shows at
    // once, the rest wait for the window to end.
    for (let v = 1; v <= 10; v++) {
      rerender({ v })
      act(() => void vi.advanceTimersByTime(50))
    }
    expect(result.current).toBe(1)
    act(() => void vi.advanceTimersByTime(1000))
    expect(result.current).toBe(10) // the latest, once the window ends
    for (let v = 11; v <= 20; v++) {
      rerender({ v })
      act(() => void vi.advanceTimersByTime(10))
    }
    expect(result.current).toBe(10) // a new window: still waiting
    act(() => void vi.advanceTimersByTime(1000))
    expect(result.current).toBe(20)
  })
})
