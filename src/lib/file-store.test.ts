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

  it("a failed read shows as an error; one landing after its entry closed is dropped", async () => {
    const read = vi.fn().mockRejectedValueOnce(new Error("EIO")).mockResolvedValue(text("late"))
    const s = new FileStore(read, hl)
    s.show("f1", "/w/x")
    await tick()
    expect(s.get("f1")!.data).toMatchObject({ kind: "error", message: "Error: EIO" })
    s.refresh("f1")
    s.forget("f1") // closed while that read runs
    await tick()
    expect(s.get("f1")).toBeUndefined()
  })

  it("a highlight that lands after a newer text is dropped (the newer one's wins)", async () => {
    const { read, pending } = reads()
    let release: (l: string[]) => void = () => {}
    const slow = vi
      .fn()
      .mockImplementationOnce(() => new Promise<string[]>((r) => (release = r)))
      .mockImplementation(async (t: string) => [`<i>${t}</i>`])
    const s = new FileStore(read, slow)
    s.show("f2", "/w/y.ts")
    pending.shift()!.resolve(text("old"))
    await tick()
    s.refresh("f2")
    pending.shift()!.resolve(text("new", 2))
    await tick()
    release(["<i>old</i>"]) // the first text's highlight, late
    await tick()
    expect(s.get("f2")!.lines).toEqual(["<i>new</i>"])
  })

  it("a changed file's diff: plain at once, highlighted by side, read again only on a new key", async () => {
    const { read } = reads()
    const lines = [
      { type: "hunk" as const, text: "@@ -1,2 +1,2 @@" },
      { type: "context" as const, text: "a", oldNo: 1, newNo: 1 },
      { type: "del" as const, text: "b<", oldNo: 2 },
      { type: "add" as const, text: "c", newNo: 2 },
    ]
    const diffOf = vi.fn(async () => lines)
    const s = new FileStore(read, hl, 16, diffOf)
    s.show("d1", "/w/r/x.ts")
    s.wantDiff("d1", { root: "/w/r", rel: "x.ts", key: "M:1:1:5" })
    expect(diffOf).toHaveBeenCalledWith("/w/r", "x.ts", undefined)
    await tick()
    await tick()
    const d = s.get("d1")!.diff!
    expect(d.bars.get(2)).toBe("mod")
    expect(d.html).toEqual(["@@ -1,2 +1,2 @@", "<b>a</b>", "<b>b<</b>", "<b>c</b>"])
    s.wantDiff("d1", { root: "/w/r", rel: "x.ts", key: "M:1:1:5" }) // same key: kept
    expect(diffOf).toHaveBeenCalledTimes(1)
    s.wantDiff("d1", null) // unchanged now
    expect(s.get("d1")!.diff).toBeNull()
  })

  it("a diff that fails to read is an empty one; one for a closed tab is dropped", async () => {
    const { read } = reads()
    const s = new FileStore(
      read,
      async (t) => [t],
      16,
      vi.fn(async () => Promise.reject(new Error("x"))),
    )
    s.show("d2", "/w/y.ts")
    s.wantDiff("d2", { root: "/w", rel: "y.ts", key: "D:0:1:0" })
    await tick()
    expect(s.get("d2")!.diff).toEqual({ lines: [], html: [], bars: new Map() })
    let land: (l: never[]) => void = () => {}
    const s2 = new FileStore(read, hl, 16, () => new Promise((r) => (land = r)))
    s2.show("d3", "/w/z.ts")
    s2.wantDiff("d3", { root: "/w", rel: "z.ts", key: "k" })
    s2.forget("d3")
    land([])
    await tick()
    expect(s2.get("d3")).toBeUndefined()
    s2.wantDiff("nope", { root: "/w", rel: "z.ts", key: "k" }) // not shown: nothing
  })
})
