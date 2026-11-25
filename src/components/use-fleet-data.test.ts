import { describe, it, expect, vi, afterEach } from "vitest"
import { act, renderHook } from "@testing-library/react"
import { useThrottledStore } from "./use-fleet-data"
import { useStore } from "../store"
import { ipc } from "../lib/ipc"

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
