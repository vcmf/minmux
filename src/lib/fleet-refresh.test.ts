import { describe, it, expect, vi } from "vitest"
import { FleetRefresh, type RefreshDeps } from "./fleet-refresh"
import type { PrLocalResult } from "./pr-local"
import type { PrListsResult } from "./pr-dashboard"

// A fake clock with timers, and controllable answers.
function harness(over: Partial<RefreshDeps> = {}) {
  let now = 1_000_000
  let timers: { at: number; fn: () => void; id: number }[] = []
  let id = 0
  const state = { roots: ["/w/r"], hidden: false }
  const prLocal = vi.fn<RefreshDeps["prLocal"]>(
    async (req) =>
      ({ ok: true, repos: [{ repo: req.roots.join(","), worktrees: [] }] }) as PrLocalResult,
  )
  const prLists = vi.fn<RefreshDeps["prLists"]>(
    async () => ({ ok: true, lists: { mine: [], review: [] } }) as PrListsResult,
  )
  const deps: RefreshDeps = {
    prLocal,
    prLists,
    roots: () => state.roots,
    hidden: () => state.hidden,
    now: () => now,
    setTimer: (fn, ms) => {
      timers.push({ at: now + ms, fn, id: ++id })
      return id
    },
    clearTimer: (t) => {
      timers = timers.filter((x) => x.id !== t)
    },
    ...over,
  }
  const flush = async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve()
  }
  const advance = async (ms: number) => {
    const end = now + ms
    for (;;) {
      await flush()
      const next = timers.filter((t) => t.at <= end).sort((a, b) => a.at - b.at)[0]
      if (!next) break
      timers = timers.filter((t) => t !== next)
      now = next.at
      next.fn()
    }
    now = end
    await flush()
  }
  return { r: new FleetRefresh(deps), prLocal, prLists, state, advance, flush }
}

describe("FleetRefresh", () => {
  it("asks both on the first subscriber, then at the cadence", async () => {
    const h = harness()
    const off = h.r.subscribe(() => {})
    await h.flush()
    expect(h.prLists).toHaveBeenCalledTimes(1)
    expect(h.prLocal).toHaveBeenCalledTimes(1)
    await h.advance(59_000)
    expect(h.prLists).toHaveBeenCalledTimes(1)
    await h.advance(2_000)
    expect(h.prLists).toHaveBeenCalledTimes(2)
    off()
  })

  it("switching the tab away and back doesn't ask GitHub before the cadence", async () => {
    const h = harness()
    h.r.subscribe(() => {})()
    await h.flush()
    for (let i = 0; i < 5; i++) {
      const off = h.r.subscribe(() => {})
      await h.advance(1_000)
      off()
    }
    expect(h.prLists).toHaveBeenCalledTimes(1)
    expect(h.prLocal).toHaveBeenCalledTimes(6) // the repos each time (cheap, local)
  })

  it("no pane in a repo any more: the repos list empties", async () => {
    const h = harness()
    h.r.subscribe(() => {})
    await h.flush()
    expect(h.r.get().local).toHaveLength(1)
    h.state.roots = []
    h.r.rootsChanged()
    await h.advance(600)
    expect(h.r.get().local).toEqual([])
  })

  it("stops with the last subscriber", async () => {
    const h = harness()
    h.r.subscribe(() => {})()
    await h.advance(10 * 60_000)
    expect(h.prLists).toHaveBeenCalledTimes(1)
  })

  it("roots changes: the repos once (debounced), never GitHub", async () => {
    const h = harness()
    h.r.subscribe(() => {})
    await h.flush()
    h.state.roots = ["/w/r", "/w/b"]
    h.r.rootsChanged()
    h.r.rootsChanged()
    h.r.rootsChanged()
    await h.advance(600)
    expect(h.prLocal).toHaveBeenCalledTimes(2)
    expect(h.prLists).toHaveBeenCalledTimes(1)
    expect(h.r.get().local[0]!.repo).toBe("/w/r,/w/b")
  })

  it("one run at a time: an ask during a run runs next, with the roots of then", async () => {
    let release: () => void = () => {}
    const h = harness()
    h.prLocal.mockImplementationOnce(
      (req) =>
        new Promise((ok) => {
          release = () => ok({ ok: true, repos: [{ repo: req.roots.join(","), worktrees: [] }] })
        }),
    )
    h.r.subscribe(() => {})
    await h.flush()
    h.state.roots = ["/w/new"]
    h.r.rootsChanged()
    await h.advance(600) // debounced ask while the first run is still out
    expect(h.prLocal).toHaveBeenCalledTimes(1)
    release()
    await h.advance(10)
    expect(h.prLocal).toHaveBeenCalledTimes(2)
    expect(h.r.get().local[0]!.repo).toBe("/w/new") // the newer ask's answer is what's kept
  })

  it("nothing while hidden; what came due runs when it shows", async () => {
    const h = harness()
    h.r.subscribe(() => {})
    await h.flush()
    h.state.hidden = true
    await h.advance(5 * 60_000)
    expect(h.prLists).toHaveBeenCalledTimes(1)
    h.state.hidden = false
    h.r.shown()
    await h.flush()
    expect(h.prLists).toHaveBeenCalledTimes(2)
  })

  it("backs off after failures, and remembers it across subscriptions", async () => {
    const h = harness()
    h.prLists.mockResolvedValue({ ok: false, error: "network" } as unknown as PrListsResult)
    h.r.subscribe(() => {})()
    await h.flush()
    const off = h.r.subscribe(() => {})
    await h.advance(61_000) // one failure: a minute
    expect(h.prLists).toHaveBeenCalledTimes(2)
    await h.advance(61_000) // two: two minutes
    expect(h.prLists).toHaveBeenCalledTimes(2)
    await h.advance(60_000)
    expect(h.prLists).toHaveBeenCalledTimes(3)
    off()
  })

  it("a low GraphQL budget waits for its reset, however often the tab comes back", async () => {
    const h = harness()
    const reset = new Date(1_000_000 + 600_000).toISOString()
    h.prLists.mockResolvedValue({
      ok: true,
      lists: { mine: [], review: [], remaining: 100, resetAt: reset },
    } as PrListsResult)
    h.r.subscribe(() => {})()
    await h.flush()
    for (let i = 0; i < 5; i++) {
      await h.advance(100_000) // back halfway and later: still before the reset
      const off = h.r.subscribe(() => {})
      await h.flush()
      off()
    }
    expect(h.prLists).toHaveBeenCalledTimes(1)
    await h.advance(101_000)
    const off = h.r.subscribe(() => {})
    await h.flush()
    expect(h.prLists).toHaveBeenCalledTimes(2) // past the reset
    off()
  })

  it("the same repos answer again tells nobody", async () => {
    const h = harness()
    const heard = vi.fn()
    h.r.subscribe(heard)
    await h.flush()
    const calls = heard.mock.calls.length
    h.r.rootsChanged()
    await h.advance(600)
    expect(h.prLocal).toHaveBeenCalledTimes(2)
    expect(heard.mock.calls.length).toBe(calls)
  })

  it("an ask in flight isn't due again: coming back meanwhile doesn't ask twice", async () => {
    let answer: (r: PrListsResult) => void = () => {}
    const h = harness()
    h.prLists.mockImplementationOnce(() => new Promise((ok) => (answer = ok)))
    h.r.subscribe(() => {})()
    await h.flush()
    const off = h.r.subscribe(() => {}) // back while GitHub is still answering
    await h.flush()
    answer({ ok: true, lists: { mine: [], review: [] } } as PrListsResult)
    await h.advance(10)
    expect(h.prLists).toHaveBeenCalledTimes(1)
    off()
  })

  it("a throw inside a run doesn't stop it for good", async () => {
    let fail = true
    const h = harness({
      roots: () => {
        if (fail) throw new Error("bad paneGit")
        return ["/w/r"]
      },
    })
    h.r.subscribe(() => {})
    await h.flush()
    fail = false
    h.r.rootsChanged()
    await h.advance(600)
    expect(h.prLocal).toHaveBeenCalledTimes(1)
  })
})
