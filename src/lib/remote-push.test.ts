import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { RemotePanes } from "./remote-protocol"
import { PUSH_MS, startRemotePush } from "./remote-push"

describe("startRemotePush", () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it("pushes only while wanted, throttled, and only changes", async () => {
    let n = 0
    const sent: RemotePanes[] = []
    const subs = new Set<() => void>()
    let onWanted: (w: boolean) => void = () => {}
    const stop = startRemotePush({
      build: () => ({ tabs: [{ id: String(n > 1 ? n : 0), title: "" }], panes: [], stale: false }),
      send: (p) => sent.push(p),
      subscribe: (fn) => (subs.add(fn), () => subs.delete(fn)),
      wanted: async () => false,
      onWanted: (fn) => ((onWanted = fn), () => {}),
    })
    await Promise.resolve()
    expect(subs.size).toBe(0) // nothing while nobody's connected
    onWanted(true)
    expect(sent).toHaveLength(1)
    n = 1
    subs.forEach((f) => f())
    subs.forEach((f) => f())
    vi.advanceTimersByTime(PUSH_MS)
    expect(sent).toHaveLength(1) // same content
    n = 2
    subs.forEach((f) => f())
    vi.advanceTimersByTime(PUSH_MS)
    expect(sent).toHaveLength(2)
    n = 3
    vi.advanceTimersByTime(1000 + PUSH_MS) // the periodic rebuild, no store change
    expect(sent).toHaveLength(3)
    onWanted(false)
    expect(subs.size).toBe(0)
    n = 4
    vi.advanceTimersByTime(5000)
    expect(sent).toHaveLength(3)
    stop()
  })
})
