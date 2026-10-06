import { describe, it, expect } from "vitest"
import { ReadQueue, type ReadTask } from "./read-queue"

/** A manual clock: timers fire only on advance(). */
function fakeClock() {
  let t = 0
  let timers: { at: number; fn: () => void }[] = []
  return {
    now: () => t,
    setTimeout: (fn: () => void, ms: number) => {
      const timer = { at: t + ms, fn }
      timers.push(timer)
      return () => void (timers = timers.filter((x) => x !== timer))
    },
    async advance(ms: number) {
      const end = t + ms
      for (;;) {
        await flush()
        const due = timers.filter((x) => x.at <= end).sort((a, b) => a.at - b.at)[0]
        if (!due) break
        timers = timers.filter((x) => x !== due)
        t = Math.max(t, due.at)
        due.fn()
      }
      t = end
      await flush()
    },
  }
}
const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

/** A queue whose reads log their key and finish when `finish(key)` is called. */
function setup() {
  const clock = fakeClock()
  const q = new ReadQueue(clock, 250, 5000, 1000, 10_000)
  const started: string[] = []
  const pending = new Map<string, () => void>()
  const task = (key: string, extra: Partial<ReadTask> = {}): ReadTask => ({
    key,
    run: () => {
      started.push(key)
      return new Promise<void>((r) => pending.set(key, r))
    },
    ...extra,
  })
  const finish = async (key: string) => {
    pending.get(key)?.()
    pending.delete(key)
    await flush()
  }
  return { q, clock, started, task, finish }
}

describe("ReadQueue", () => {
  it("one read at a time, at most one start per gap", async () => {
    const { q, clock, started, task, finish } = setup()
    q.request(task("a"))
    q.request(task("b"))
    q.request(task("c"))
    await flush()
    expect(started).toEqual(["a"])
    await finish("a")
    expect(started).toEqual(["a"]) // finished at once, but the gap isn't over
    await clock.advance(250)
    expect(started).toEqual(["a", "b"])
    await finish("b")
    await clock.advance(250)
    expect(started).toEqual(["a", "b", "c"])
  })

  it("a folder already queued isn't queued twice", async () => {
    const { q, clock, started, task, finish } = setup()
    q.request(task("a"))
    q.request(task("b"))
    q.request(task("b"))
    await flush()
    await finish("a")
    await clock.advance(250)
    await finish("b")
    await clock.advance(1000)
    expect(started).toEqual(["a", "b"])
    expect(q.size).toBe(0)
  })

  it("asked again while being read: read exactly once more after", async () => {
    const { q, clock, started, task, finish } = setup()
    q.request(task("a"))
    await flush()
    q.request(task("a"))
    q.request(task("a"))
    await finish("a")
    await clock.advance(250)
    expect(started).toEqual(["a", "a"])
    await finish("a")
    await clock.advance(1000)
    expect(started).toEqual(["a", "a"])
  })

  it("an urgent read goes ahead of background reads, still one gap apart", async () => {
    const { q, clock, started, task, finish } = setup()
    q.request(task("a"))
    q.request(task("b"))
    await flush()
    await finish("a")
    q.request(task("u", { urgent: true }))
    await clock.advance(249)
    expect(started).toEqual(["a"])
    await clock.advance(1)
    expect(started).toEqual(["a", "u"]) // ahead of b
    await finish("u")
    await clock.advance(250)
    expect(started).toEqual(["a", "u", "b"])
  })

  it("urgent requests keep the order they were asked in, even when re-asked", async () => {
    const { q, clock, started, task, finish } = setup()
    q.request(task("bg"))
    await flush()
    q.request(task("u1", { urgent: true }))
    q.request(task("u2", { urgent: true }))
    q.request(task("u1", { urgent: true })) // re-asked: keeps its place
    await finish("bg")
    await clock.advance(250)
    await finish("u1")
    await clock.advance(250)
    expect(started).toEqual(["bg", "u1", "u2"])
  })

  it("a user request during that folder's read stays urgent for the follow-up", async () => {
    const { q, clock, started, task, finish } = setup()
    q.request(task("a"))
    q.request(task("bg"))
    await flush()
    q.request(task("a", { urgent: true }))
    await finish("a")
    await clock.advance(250)
    expect(started).toEqual(["a", "a"]) // ahead of bg
  })

  it("a big folder is re-read at most once per big gap; others aren't held behind it", async () => {
    const { q, clock, started, task, finish } = setup()
    q.request(task("big", { big: true }))
    await flush()
    await finish("big")
    q.request(task("big", { big: true }))
    q.request(task("small"))
    await clock.advance(250)
    expect(started).toEqual(["big", "small"])
    await finish("small")
    await clock.advance(4000)
    expect(started).toEqual(["big", "small"])
    await clock.advance(1000)
    expect(started).toEqual(["big", "small", "big"])
  })

  it("an urgent request shortens a big folder's back-off but keeps one (repeated Refresh)", async () => {
    const { q, clock, started, task, finish } = setup()
    q.request(task("big", { big: true }))
    await flush()
    await finish("big")
    q.request(task("big", { big: true, urgent: true }))
    await clock.advance(999)
    expect(started).toEqual(["big"])
    await clock.advance(2)
    expect(started).toEqual(["big", "big"])
  })

  it("a stuck read frees the queue; only that folder waits until it settles", async () => {
    const { q, clock, started, task, finish } = setup()
    q.request(task("dead:/a"))
    q.request(task("dead:/b"))
    await clock.advance(10_000) // dead:/a times out: the queue moves on
    expect(started).toEqual(["dead:/a", "dead:/b"])
    expect(q.size).toBe(2) // the stuck read still counts
    await finish("dead:/b")
    q.request(task("dead:/a", { urgent: true })) // still stuck: not read again
    await clock.advance(1000)
    expect(started).toEqual(["dead:/a", "dead:/b"])
    await finish("dead:/a") // finally settles
    await clock.advance(1000)
    expect(started).toEqual(["dead:/a", "dead:/b", "dead:/a"])
  })

  it("several clicks are read in the order clicked", async () => {
    const { q, clock, started, task, finish } = setup()
    q.request(task("bg"))
    await flush()
    q.request(task("A", { front: true }))
    q.request(task("B", { front: true }))
    await finish("bg")
    await clock.advance(250)
    await finish("A")
    await clock.advance(250)
    expect(started).toEqual(["bg", "A", "B"])
  })

  it("skipIfReadWithin drops a request for a folder read moments ago", async () => {
    const { q, clock, started, task, finish } = setup()
    q.request(task("a"))
    await flush()
    await finish("a")
    q.request(task("a", { skipIfReadWithin: 1000 }))
    await clock.advance(500)
    expect(started).toEqual(["a"])
    q.request(task("a", { skipIfReadWithin: 1000 }))
    await clock.advance(600)
    q.request(task("a", { skipIfReadWithin: 1000 }))
    await clock.advance(10)
    expect(started).toEqual(["a", "a"])
  })

  it("front (a click on a folder not yet listed) goes ahead of an urgent batch", async () => {
    const { q, clock, started, task, finish } = setup()
    q.request(task("bg"))
    await flush()
    q.request(task("r1", { urgent: true }))
    q.request(task("r2", { urgent: true }))
    q.request(task("click", { front: true }))
    await finish("bg")
    await clock.advance(250)
    expect(started).toEqual(["bg", "click"])
  })

  it("a run that throws synchronously doesn't stall the queue", async () => {
    const { q, clock } = setup()
    const ran: string[] = []
    q.request({
      key: "x",
      run: () => {
        throw new Error("no ipc")
      },
    })
    q.request({ key: "y", run: async () => void ran.push("y") })
    await clock.advance(1000)
    expect(ran).toEqual(["y"])
    expect(q.size).toBe(0)
  })

  it("a failed read doesn't stall the queue; the latest request's run is used", async () => {
    const { q, clock } = setup()
    const ran: string[] = []
    q.request({ key: "x", run: () => Promise.reject(new Error("EACCES")) })
    q.request({ key: "y", run: async () => void ran.push("old") })
    q.request({ key: "y", run: async () => void ran.push("new") })
    await clock.advance(1000)
    expect(ran).toEqual(["new"])
    expect(q.size).toBe(0)
  })

  it("a timer that fires early (clock behind) doesn't stall the queue", async () => {
    const clock = fakeClock()
    let early = 0
    const skewed = {
      now: clock.now,
      // fire 2 ms early once: the queue must re-arm instead of waiting for the next request
      setTimeout: (fn: () => void, ms: number) =>
        clock.setTimeout(fn, ms - (early++ === 0 ? 2 : 0)),
    }
    const q = new ReadQueue(skewed, 250, 5000, 1000, 10_000)
    const started: string[] = []
    q.request({ key: "a", run: async () => void started.push("a") })
    q.request({ key: "b", run: async () => void started.push("b") })
    await clock.advance(1000)
    expect(started).toEqual(["a", "b"])
  })

  it("drop removes queued reads (a root no longer shown)", async () => {
    const { q, clock, started, task, finish } = setup()
    q.request(task("r1:/a"))
    q.request(task("r1:/b"))
    q.request(task("r2:/c"))
    await flush()
    q.drop((k) => k.startsWith("r1:"))
    await finish("r1:/a") // already running: unaffected
    await clock.advance(1000)
    expect(started).toEqual(["r1:/a", "r2:/c"])
  })
})
