import { describe, it, expect, vi } from "vitest"
import { FileStore } from "./file-store"
import type { FileData } from "./file-tab"

const text = (t: string, mtimeMs = 1): FileData => ({
  kind: "text",
  text: t,
  truncated: false,
  size: t.length,
  stamp: { size: t.length, mtimeMs },
})
const tick = () => new Promise((r) => setTimeout(r, 0))

/** A read the test resolves itself, one at a time. */
function reads() {
  const pending: { since: unknown; resolve: (d: FileData) => void }[] = []
  const read = vi.fn(
    (_p: string, _w: unknown, since?: unknown) =>
      new Promise<FileData>((resolve) => pending.push({ since, resolve })),
  )
  return { read, pending }
}
const hl = vi.fn(async (t: string) => t.split("\n").map((l) => `<b>${l}</b>`))

describe("FileStore", () => {
  it("reads a file once shown, highlights it, and shows it at once when shown again", async () => {
    const { read, pending } = reads()
    const s = new FileStore(read, hl)
    s.show("e1", "/w/a.ts")
    pending.shift()!.resolve(text("x\ny"))
    await tick()
    expect(s.get("e1")!.lines).toEqual(["<b>x</b>", "<b>y</b>"])
    s.setScroll("e1", 900)
    s.setWent("e1", "40:0")
    expect(s.scrollOf("e1")).toBe(900) // live, before any publish
    expect(s.wentOf("e1")).toBe("40:0")
    s.show("e1", "/w/a.ts") // the tab came back
    expect(s.get("e1")!.lines).toHaveLength(2) // at once, before any read
    expect(s.get("e1")!.scrollTop).toBe(900)
    expect(pending[0]!.since).toEqual({ size: 3, mtimeMs: 1 }) // re-read with its stamp
  })

  it("a change during a read gets one more read after it, never a cancel", async () => {
    const { read, pending } = reads()
    const s = new FileStore(read, hl)
    s.show("e2", "/w/b.ts")
    s.refresh("e2")
    s.refresh("e2") // a busy folder
    expect(read).toHaveBeenCalledTimes(1)
    pending.shift()!.resolve(text("v1"))
    await tick()
    expect(s.get("e2")!.data).toMatchObject({ text: "v1" }) // it landed
    expect(read).toHaveBeenCalledTimes(2) // …and exactly one more
    pending.shift()!.resolve(text("v2", 2))
    await tick()
    expect(s.get("e2")!.lines).toEqual(["<b>v2</b>"])
  })

  it("a re-read finding the file unchanged keeps what's shown", async () => {
    const { read, pending } = reads()
    const s = new FileStore(read, hl)
    s.show("e3", "/w/c.ts")
    pending.shift()!.resolve(text("same"))
    await tick()
    const before = s.get("e3")
    s.refresh("e3")
    pending.shift()!.resolve({ kind: "same" })
    await tick()
    expect(s.get("e3")).toBe(before)
  })

  it("keeps the most recently shown files, the rest are forgotten", () => {
    const { read } = reads()
    const s = new FileStore(read, hl, 2)
    s.show("a", "/a")
    s.hide("a")
    s.show("b", "/b")
    s.hide("b")
    s.show("c", "/c")
    expect(s.get("a")).toBeUndefined()
    expect(s.get("c")).toBeDefined()
  })

  it("another file in the same entry starts over", async () => {
    const { read, pending } = reads()
    const s = new FileStore(read, hl)
    s.show("e4", "/w/one.ts")
    pending.shift()!.resolve(text("one"))
    await tick()
    s.show("e4", "/w/two.ts")
    expect(s.get("e4")!.data).toBeNull()
  })

  it("never evicts a file still on screen", () => {
    const { read } = reads()
    const s = new FileStore(read, hl, 1)
    s.show("a", "/a") // on screen
    s.show("b", "/b") // on screen too: over the cap, but neither goes
    expect(s.get("a")).toBeDefined()
    s.hide("a")
    s.show("c", "/c")
    expect(s.get("a")).toBeUndefined() // hidden: now it goes
  })
})
