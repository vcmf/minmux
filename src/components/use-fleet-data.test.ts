import { describe, it, expect, vi, afterEach } from "vitest"
import { act, renderHook } from "@testing-library/react"
import { useThrottledStore } from "./use-fleet-data"
import { useStore } from "../store"

afterEach(() => vi.useRealTimers())

describe("useThrottledStore", () => {
  it("wakes at most once per window however often the slice changes, ending on the latest", () => {
    vi.useFakeTimers()
    vi.setSystemTime(10_000)
    let renders = 0
    const { result } = renderHook(() => {
      renders++
      return useThrottledStore("sessions", 1000)
    })
    const before = renders
    // Twenty changes within a second (as hook events move the store).
    for (let i = 0; i < 20; i++) {
      act(() => useStore.setState({ sessions: { [`s${i}`]: {} as never } }))
      act(() => void vi.advanceTimersByTime(40))
    }
    act(() => void vi.advanceTimersByTime(1000))
    expect(renders - before).toBeLessThanOrEqual(2)
    expect(Object.keys(result.current)).toEqual(["s19"])
  })
})
