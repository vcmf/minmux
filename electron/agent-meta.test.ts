import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { AgentMetaTracker, type WatchFn } from "./agent-meta"

const color = (c: string) => JSON.stringify({ type: "agent-color", agentColor: c })
const title = (t: string) => JSON.stringify({ type: "custom-title", customTitle: t })

/** A fake fs.watch: records the change callback so tests can fire "appends". */
function fakeWatch() {
  const fired: (() => void)[] = []
  const stops: string[] = []
  const watch: WatchFn = (candidates, onChange) => {
    fired.push(onChange)
    return () => stops.push(candidates[0]!)
  }
  return { watch, fire: () => fired.forEach((f) => f()), stops, count: () => fired.length }
}

describe("AgentMetaTracker", () => {
  let dir: string
  let file: string
  let emitted: [string, unknown][]
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "minmux-am-"))
    file = path.join(dir, "s.jsonl")
    emitted = []
  })
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

  // Debounce 0 + real timers: settle by waiting a tick + the async read.
  const settle = () => new Promise((r) => setTimeout(r, 30))
  const make = (w = fakeWatch()) => ({
    w,
    t: new AgentMetaTracker((id, m) => emitted.push([id, m]), w.watch, 0),
  })

  it("emits the pane's /color + /rename once they appear, then only on change", async () => {
    fs.writeFileSync(file, `${title("fix-login")}\n`)
    const { t, w } = make()
    t.track("pane1", file)
    await settle()
    expect(emitted).toEqual([["pane1", { name: "fix-login" }]])
    // A /color append fires the watcher (no hook) → re-read → emit.
    fs.appendFileSync(file, `${color("orange")}\n`)
    w.fire()
    await settle()
    expect(emitted.at(-1)).toEqual(["pane1", { name: "fix-login", color: "orange" }])
    // Nothing new → no duplicate emit.
    const n = emitted.length
    w.fire()
    await settle()
    expect(emitted).toHaveLength(n)
  })

  it("a session with no /color or /rename emits nothing", async () => {
    fs.writeFileSync(file, `${JSON.stringify({ type: "user", message: {} })}\n`)
    const { t } = make()
    t.track("pane1", file)
    await settle()
    expect(emitted).toEqual([])
  })

  it("untrack (SessionEnd / pane closed) stops the watch and clears the accent", async () => {
    fs.writeFileSync(file, `${color("blue")}\n`)
    const { t, w } = make()
    t.track("pane1", file)
    await settle()
    t.untrack("pane1")
    expect(w.stops).toEqual([file])
    expect(emitted.at(-1)).toEqual(["pane1", null])
  })

  it("a new transcript in the same pane (new claude session) restarts tracking", async () => {
    const other = path.join(dir, "s2.jsonl")
    fs.writeFileSync(file, `${color("blue")}\n`)
    fs.writeFileSync(other, `${color("pink")}\n`)
    const { t, w } = make()
    t.track("pane1", file)
    await settle()
    t.track("pane1", other)
    await settle()
    expect(w.stops).toEqual([file])
    // The old session's accent is cleared first (it may have died without a SessionEnd)…
    expect(emitted.slice(-2)).toEqual([
      ["pane1", null],
      ["pane1", { color: "pink" }], // …then the new session's own
    ])
  })

  it("a new session with no meta doesn't inherit the previous session's colour", async () => {
    const other = path.join(dir, "s2.jsonl")
    fs.writeFileSync(file, `${color("red")}\n`)
    fs.writeFileSync(other, `${JSON.stringify({ type: "user" })}\n`)
    const { t } = make()
    t.track("pane1", file)
    await settle()
    t.track("pane1", other)
    await settle()
    expect(emitted.at(-1)).toEqual(["pane1", null])
  })

  it("a late SessionEnd of the previous transcript doesn't end the new one", async () => {
    const other = path.join(dir, "s2.jsonl")
    fs.writeFileSync(other, `${color("cyan")}\n`)
    const { t, w } = make()
    t.track("pane1", other)
    await settle()
    t.untrack("pane1", true, file) // stale: `file` isn't the tracked transcript
    expect(w.stops).toEqual([])
    expect(t.snapshot()).toEqual([["pane1", { color: "cyan" }]])
  })

  it("snapshot hands a reloaded renderer every pane's current meta", async () => {
    fs.writeFileSync(file, `${title("x")}\n`)
    const { t } = make()
    t.track("pane1", file)
    t.track("pane2", path.join(dir, "missing.jsonl")) // no meta → not in the snapshot
    await settle()
    expect(t.snapshot()).toEqual([["pane1", { name: "x" }]])
  })

  it("a watch that dies is re-armed on the next event; failed attempts are throttled", () => {
    let calls = 0
    let die: () => void = () => {}
    let clock = 0
    const watch: WatchFn = (_c, _ch, onError) => {
      calls++
      die = onError
      return () => {}
    }
    const t = new AgentMetaTracker(
      () => {},
      watch,
      0,
      undefined,
      () => clock,
    )
    t.track("pane1", file)
    expect(calls).toBe(1)
    die() // watcher errored
    t.track("pane1", file)
    expect(calls).toBe(2) // re-armed immediately

    let tries = 0
    const never: WatchFn = () => (tries++, null)
    const t2 = new AgentMetaTracker(
      () => {},
      never,
      0,
      undefined,
      () => clock,
    )
    t2.track("p", file)
    t2.track("p", file) // within 5 s → not retried
    clock += 6000
    t2.track("p", file)
    expect(tries).toBe(2)
    t.dispose()
    t2.dispose()
  })

  it("coalesces a burst of events into one read", async () => {
    vi.useFakeTimers()
    try {
      fs.writeFileSync(file, `${color("red")}\n`)
      const w = fakeWatch()
      const t = new AgentMetaTracker((id, m) => emitted.push([id, m]), w.watch, 200)
      t.track("pane1", file)
      for (let i = 0; i < 10; i++) w.fire()
      await vi.advanceTimersByTimeAsync(250)
    } finally {
      vi.useRealTimers()
    }
    await settle()
    expect(emitted).toEqual([["pane1", { color: "red" }]])
  })
})
