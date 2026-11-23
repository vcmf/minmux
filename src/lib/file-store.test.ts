import { describe, it, expect, vi } from "vitest"
import { DIFF_MIN_MS, FileStore } from "./file-store"
import { HIGHLIGHT_MAX } from "./file-preview"
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

  it("a live file's diff is read at most every DIFF_MIN_MS, the last key always", async () => {
    vi.useFakeTimers()
    try {
      const { read } = reads()
      let now = 1000
      const diffOf = vi.fn(async () => [{ type: "add" as const, text: "x", newNo: 1 }])
      const s = new FileStore(read, hl, 16, diffOf, () => now)
      s.show("t1", "/w/a.ts")
      const want = (key: string) => s.wantDiff("t1", { root: "/w", rel: "a.ts", key })
      want("M:1")
      await vi.advanceTimersByTimeAsync(0)
      expect(diffOf).toHaveBeenCalledTimes(1)
      now += 200
      want("M:2") // the agent wrote again
      now += 200
      want("M:3")
      await vi.advanceTimersByTimeAsync(0)
      expect(diffOf).toHaveBeenCalledTimes(1) // waiting
      now += DIFF_MIN_MS
      await vi.advanceTimersByTimeAsync(DIFF_MIN_MS)
      expect(diffOf).toHaveBeenCalledTimes(2) // the last one
      now += 100
      want("M:4")
      s.hide("t1") // hidden before its turn: not read…
      now += DIFF_MIN_MS
      await vi.advanceTimersByTimeAsync(DIFF_MIN_MS)
      expect(diffOf).toHaveBeenCalledTimes(2)
      s.show("t1", "/w/a.ts")
      want("M:4") // …until it shows again
      await vi.advanceTimersByTimeAsync(0)
      expect(diffOf).toHaveBeenCalledTimes(3)
    } finally {
      vi.useRealTimers()
    }
  })

  it("a big diff is escaped in the worker and not highlighted", async () => {
    const { read } = reads()
    const big = "y".repeat(HIGHLIGHT_MAX)
    const h = vi.fn(async (t: string, lang: string | null) =>
      t.split("\n").map((l) => `${lang}:${l.length}`),
    )
    const s = new FileStore(read, h, 16, async () => [
      { type: "add" as const, text: big, newNo: 1 },
      { type: "add" as const, text: "z", newNo: 2 },
    ])
    s.show("b1", "/w/big.ts")
    s.wantDiff("b1", { root: "/w", rel: "big.ts", key: "k" })
    await tick()
    await tick()
    expect(h).toHaveBeenCalledTimes(1)
    expect(h.mock.calls[0]![1]).toBeNull() // plain: escaped and split there
    expect(s.get("b1")!.diff!.html).toEqual([`null:${HIGHLIGHT_MAX}`, "null:1"])
  })

  it("Source and Diff keep their own scroll", () => {
    const s = new FileStore(reads().read, hl)
    s.show("s1", "/w/a.ts")
    s.setScroll("s1", 500)
    s.setScroll("s1", 90, "diff")
    expect(s.scrollOf("s1")).toBe(500)
    expect(s.scrollOf("s1", "diff")).toBe(90)
  })

  it("a highlight that fails keeps the plain diff", async () => {
    const s = new FileStore(
      reads().read,
      () => Promise.reject(new Error("crash")),
      16,
      async () => [{ type: "add" as const, text: "a<", newNo: 1 }],
    )
    s.show("h1", "/w/a.ts")
    s.wantDiff("h1", { root: "/w", rel: "a.ts", key: "k" })
    await tick()
    await tick()
    expect(s.get("h1")!.diff!.html).toEqual(["a&lt;"])
  })

  it("a key that changes while a diff is read waits for it: one read at a time", async () => {
    vi.useFakeTimers()
    try {
      let now = 1000
      let land: (l: never[]) => void = () => {}
      const diffOf = vi.fn(() => new Promise<never[]>((r) => (land = r)))
      const s = new FileStore(reads().read, hl, 16, diffOf, () => now)
      s.show("q1", "/w/a.ts")
      s.wantDiff("q1", { root: "/w", rel: "a.ts", key: "M:0" })
      s.wantDiff("q1", { root: "/w", rel: "a.ts", key: "M:7" }) // the read landed: its stamp
      expect(diffOf).toHaveBeenCalledTimes(1)
      land([])
      await vi.advanceTimersByTimeAsync(0)
      now += DIFF_MIN_MS
      await vi.advanceTimersByTimeAsync(DIFF_MIN_MS)
      expect(diffOf).toHaveBeenCalledTimes(2) // the newer key, after
    } finally {
      vi.useRealTimers()
    }
  })

  it("a big diff the worker can't escape is escaped here instead", async () => {
    const big = "y".repeat(HIGHLIGHT_MAX)
    const s = new FileStore(
      reads().read,
      () => Promise.reject(new Error("gone")),
      16,
      async () => [{ type: "add" as const, text: big, newNo: 1 }],
    )
    s.show("b2", "/w/big.ts")
    s.wantDiff("b2", { root: "/w", rel: "big.ts", key: "k" })
    await tick()
    await tick()
    expect(s.get("b2")!.diff!.html).toEqual([big])
  })
})
