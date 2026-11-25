import { describe, it, expect, vi, afterEach } from "vitest"
import { act, renderHook } from "@testing-library/react"
import { useThrottled } from "./use-fleet-data"
import { ipc } from "../lib/ipc"

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

describe("useFleetData", () => {
  it("switching the tab away and back doesn't ask GitHub again before the cadence is up", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(100_000)
    vi.resetModules() // its module state (last answers, when last asked) starts empty
    const { useFleetData } = await import("./use-fleet-data")
    const lists = vi
      .spyOn(ipc, "prLists")
      .mockResolvedValue({ ok: true, lists: { mine: [], review: [] } })
    vi.spyOn(ipc, "prLocal").mockResolvedValue({ ok: true, repos: [] })
    const first = renderHook(() => useFleetData())
    await act(async () => void (await vi.advanceTimersByTimeAsync(10)))
    expect(lists).toHaveBeenCalledTimes(1)
    first.unmount()
    for (let i = 0; i < 5; i++) {
      const again = renderHook(() => useFleetData()) // back and forth
      await act(async () => void (await vi.advanceTimersByTimeAsync(1000)))
      again.unmount()
    }
    expect(lists).toHaveBeenCalledTimes(1)
    const last = renderHook(() => useFleetData())
    await act(async () => void (await vi.advanceTimersByTimeAsync(60_000)))
    expect(lists).toHaveBeenCalledTimes(2) // the cadence, once
    last.unmount()
    vi.restoreAllMocks()
  })
})
