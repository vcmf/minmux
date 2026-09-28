import { describe, expect, it } from "vitest"
import { PendingSpawns } from "./pending-spawns"

/** A spawn whose work finishes when `done()` is called, reporting its own outcome. */
function controlled<S>(p: PendingSpawns<S>, id: string, sender: S) {
  let done!: () => void
  const gate = new Promise<void>((r) => (done = r))
  const job = p.start(id, sender, 80, 24, async (outcome) => {
    await gate
    return outcome()
  })
  return { job, done }
}

describe("PendingSpawns", () => {
  it("ignores ids that aren't pending (the caller then uses the live PTY)", () => {
    const p = new PendingSpawns<string>()
    expect(p.join("x", "r", 80, 24)).toBeNull()
    expect(p.resize("x", 100, 30)).toBe(false)
    expect(p.pending("x")).toBe(false)
    expect(p.kill("x")).toBe(false)
    expect(p.live).toBe(0)
  })

  it("reports the latest size and no close", async () => {
    const p = new PendingSpawns<string>()
    const { job, done } = controlled(p, "s", "r1")
    expect(p.pending("s")).toBe(true) // keystrokes now are swallowed by the caller
    expect(p.resize("s", 120, 40)).toBe(true)
    p.resize("s", 132, 43)
    done()
    expect(await job).toEqual({ sender: "r1", cols: 132, rows: 43, killed: false })
    expect(p.pending("s")).toBe(false) // settled: no longer pending
  })

  it("keeps the old size for a transient 0×0 resize", async () => {
    const p = new PendingSpawns<string>()
    const { job, done } = controlled(p, "s", "r")
    p.resize("s", 0, 0)
    done()
    expect(await job).toMatchObject({ cols: 80, rows: 24 })
  })

  it("records a close; a later request doesn't join it (it's a new pane)", async () => {
    const p = new PendingSpawns<string>()
    const { job, done } = controlled(p, "s", "r1")
    expect(p.kill("s")).toBe(true)
    expect(p.join("s", "r2", 100, 30)).toBeNull()
    done()
    expect(await job).toMatchObject({ killed: true, sender: "r1" })
  })

  it("a closed spawn replaced by a new one for the same id: the old loses, the new is untouched", async () => {
    const p = new PendingSpawns<string>()
    const old = controlled(p, "s", "r1")
    p.kill("s")
    const fresh = controlled(p, "s", "r2") // the reloaded renderer restored the pane
    p.resize("s", 100, 30) // goes to the new spawn
    old.done()
    expect(await old.job).toMatchObject({ killed: true, cols: 80 })
    expect(p.pending("s")).toBe(true) // the old one settling doesn't drop the new entry
    fresh.done()
    expect(await fresh.job).toMatchObject({ killed: false, sender: "r2", cols: 100, rows: 30 })
    expect(p.pending("s")).toBe(false)
  })

  it("a reloaded renderer joins: it becomes the output target and size, same promise", async () => {
    const p = new PendingSpawns<string>()
    const { job, done } = controlled(p, "s", "old-renderer")
    expect(p.join("s", "new-renderer", 100, 30)).toBe(job) // never a second spawn
    done()
    expect(await job).toMatchObject({ sender: "new-renderer", cols: 100, rows: 30 })
  })

  it("a failing spawn fails every request that joined it", async () => {
    const p = new PendingSpawns<string>()
    const job = p.start("s", "r1", 80, 24, async () => {
      throw new Error("plan failed")
    })
    const joined = p.join("s", "r2", 80, 24)
    await expect(job).rejects.toThrow("plan failed")
    await expect(joined).rejects.toThrow("plan failed")
    expect(p.join("s", "r3", 80, 24)).toBeNull() // settled: the next request starts fresh
  })

  it("counts only still-wanted spawns as live", () => {
    const p = new PendingSpawns<string>()
    controlled(p, "a", "r")
    controlled(p, "b", "r")
    expect(p.live).toBe(2)
    p.kill("a") // closed while it prepared: not a session the quit dialog should mention
    expect(p.live).toBe(1)
  })
})

describe("PendingSpawns — closed entries and quitting", () => {
  it("a closed entry winding down no longer owns the id (a reopened pane's keys and resizes are its own)", () => {
    const p = new PendingSpawns<string>()
    controlled(p, "s", "r")
    p.kill("s")
    expect(p.pending("s")).toBe(false) // keystrokes go to the new local PTY, not swallowed
    expect(p.resize("s", 100, 30)).toBe(false) // …and so do resizes
  })

  it("killAll closes every spawn still preparing", async () => {
    const p = new PendingSpawns<string>()
    const a = controlled(p, "a", "r")
    const b = controlled(p, "b", "r")
    p.killAll()
    expect(p.live).toBe(0)
    a.done()
    b.done()
    expect((await a.job).killed).toBe(true)
    expect((await b.job).killed).toBe(true)
  })
})
