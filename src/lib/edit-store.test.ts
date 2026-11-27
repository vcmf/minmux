import { describe, expect, it, vi } from "vitest"
import { EditStore } from "./edit-store"
import type { FileData, SaveResult } from "./file-tab"

const stamp = { size: 3, mtimeMs: 1 }
const text = (t: string, hash: string): FileData => ({
  kind: "text",
  text: t,
  truncated: false,
  size: t.length,
  stamp,
  hash,
  editable: true,
})

function make(write: (...a: unknown[]) => Promise<SaveResult>, read = vi.fn()) {
  const fileStore = { pin: vi.fn(), saved: vi.fn() }
  const store = new EditStore(write as never, read as never, fileStore)
  return { store, fileStore, read }
}

describe("EditStore", () => {
  it("start keeps the base as the editor holds it (CRLF, BOM) and pins the file", () => {
    const { store, fileStore } = make(vi.fn())
    store.start("e", "/a.ts", undefined, "﻿a\r\nb\r\n", "h0")
    expect(store.base("e")).toMatchObject({ text: "a\nb\n", eol: "\r\n", bom: true, hash: "h0" })
    expect(fileStore.pin).toHaveBeenCalledWith("e", true)
    expect(store.get("e")).toEqual({ dirty: false, saving: false, notice: null, mixed: false })
  })

  it("only dirty changes publish", () => {
    const { store } = make(vi.fn())
    store.start("e", "/a", undefined, "x", "h")
    const fn = vi.fn()
    store.subscribe(fn)
    store.keep("e", {})
    store.setDirty("e", false)
    expect(fn).not.toHaveBeenCalled()
    store.setDirty("e", true)
    expect(fn).toHaveBeenCalledTimes(1)
    expect(store.unsaved()).toEqual(["e"])
  })

  it("a save writes the disk form over the base, then moves the base", async () => {
    const write = vi.fn(async () => ({ kind: "saved", stamp, hash: "h1" }) as SaveResult)
    const { store, fileStore } = make(write)
    store.start("e", "/a", undefined, "a\r\n", "h0")
    expect(await store.save("e", "a\nb\n")).toBe("saved")
    expect(write).toHaveBeenCalledWith("/a", "a\r\nb\r\n", "h0", undefined, false)
    expect(store.base("e")).toMatchObject({ text: "a\nb\n", hash: "h1" })
    expect(fileStore.saved).toHaveBeenCalledWith("e", "a\r\nb\r\n", stamp, "h1")
  })

  it("changed and missing become notices", async () => {
    const { store } = make(vi.fn(async () => ({ kind: "changed" }) as SaveResult))
    store.start("e", "/a", undefined, "a", "h0")
    expect(await store.save("e", "b")).toBe("changed")
    expect(store.get("e")?.notice).toEqual({ kind: "changed" })
    expect(store.get("e")?.saving).toBe(false)
  })

  it("overwrite saves over the bytes there now", async () => {
    const write = vi.fn(async () => ({ kind: "saved", stamp, hash: "h2" }) as SaveResult)
    const read = vi.fn(async () => text("theirs", "hT"))
    const { store } = make(write, read)
    store.start("e", "/a", undefined, "a", "h0")
    await store.save("e", "mine", { overwrite: true })
    expect(write).toHaveBeenCalledWith("/a", "mine", "hT", undefined, false)
  })

  it("overwrite writes a deleted file back, but never on another read error", async () => {
    const write = vi.fn(async () => ({ kind: "saved", stamp, hash: "h2" }) as SaveResult)
    const read = vi.fn(async (): Promise<FileData> => ({
      kind: "error",
      message: "gone",
      gone: true,
    }))
    const { store } = make(write, read)
    store.start("e", "/a", undefined, "a", "h0")
    await store.save("e", "mine", { overwrite: true })
    expect(write).toHaveBeenLastCalledWith("/a", "mine", null, undefined, true)
    write.mockClear()
    read.mockResolvedValue({ kind: "error", message: "EACCES" })
    expect(await store.save("e", "mine", { overwrite: true })).toBe("error")
    expect(write).not.toHaveBeenCalled()
  })

  it("keeps the line it opened at", () => {
    const { store } = make(vi.fn())
    store.start("e", "/a", undefined, "a\nb\n", "h", 2)
    expect(store.startLine("e")).toBe(2)
  })

  it("an unknown save that landed (the file holds our text) counts as saved", async () => {
    const read = vi.fn(async () => text("mine", "hM"))
    const { store } = make(
      vi.fn(async () => ({ kind: "unknown" }) as SaveResult),
      read,
    )
    store.start("e", "/a", undefined, "a", "h0")
    expect(await store.save("e", "mine")).toBe("saved")
    expect(store.base("e")?.hash).toBe("hM")
  })

  it("an unknown save that didn't land stays unknown", async () => {
    const read = vi.fn(async () => text("old", "h0"))
    const { store } = make(
      vi.fn(async () => ({ kind: "unknown" }) as SaveResult),
      read,
    )
    store.start("e", "/a", undefined, "old", "h0")
    expect(await store.save("e", "mine")).toBe("unknown")
    expect(store.get("e")?.notice).toEqual({ kind: "unknown" })
  })

  it("one save at a time", async () => {
    let finish!: (r: SaveResult) => void
    const write = vi.fn(() => new Promise<SaveResult>((r) => (finish = r)))
    const { store } = make(write)
    store.start("e", "/a", undefined, "a", "h0")
    const first = store.save("e", "b")
    expect(await store.save("e", "c")).toBe("busy")
    expect(store.unsaved()).toEqual(["e"]) // a save in flight counts as unsaved
    finish({ kind: "saved", stamp, hash: "h1" })
    await first
  })

  it("reload takes the file as it is now as the base", async () => {
    const read = vi.fn(async () => text("theirs\r\n", "hT"))
    const { store } = make(vi.fn(), read)
    store.start("e", "/a", undefined, "a", "h0")
    store.setDirty("e", true)
    expect(await store.reload("e")).toMatchObject({ text: "theirs\n", hash: "hT" })
    expect(store.get("e")?.dirty).toBe(false)
  })

  it("stop unpins and forgets", () => {
    const { store, fileStore } = make(vi.fn())
    store.start("e", "/a", undefined, "a", "h0")
    store.stop("e")
    expect(store.get("e")).toBeUndefined()
    expect(fileStore.pin).toHaveBeenLastCalledWith("e", false)
  })

  it("a reload that can't read text says so and keeps the base", async () => {
    const read = vi.fn(async (): Promise<FileData> => ({ kind: "binary", size: 3 }))
    const { store } = make(vi.fn(), read)
    store.start("e", "/a", undefined, "a", "h0")
    expect(await store.reload("e")).toBeNull()
    expect(store.get("e")?.notice).toMatchObject({ kind: "error" })
    store.dismiss("e")
    expect(store.get("e")?.notice).toBeNull()
    expect(store.base("e")?.hash).toBe("h0")
  })

  it("an edit closed while saving keeps nothing", async () => {
    let finish!: (r: SaveResult) => void
    const { store, fileStore } = make(vi.fn(() => new Promise<SaveResult>((r) => (finish = r))))
    store.start("e", "/a", undefined, "a", "h0")
    const p = store.save("e", "b")
    store.stop("e")
    finish({ kind: "saved", stamp, hash: "h1" })
    expect(await p).toBe("saved")
    expect(fileStore.saved).not.toHaveBeenCalled()
    expect(await store.save("e", "c")).toBe("error") // not editing any more
  })

  it("a write that throws is an error notice", async () => {
    const { store } = make(vi.fn(async () => Promise.reject(new Error("ipc gone"))))
    store.start("e", "/a", undefined, "a", "h0")
    expect(await store.save("e", "b")).toBe("error")
    expect(store.get("e")?.notice).toMatchObject({ kind: "error" })
  })

  it("keeps the editor's state, scroll and the view it last saw", () => {
    const { store } = make(vi.fn())
    store.start("e", "/a", undefined, "a", "h0", 1, "preview")
    const snap = { s: 1 }
    store.keep("e", snap)
    store.setScroll("e", "scroll")
    expect(store.state("e")).toBe(snap)
    expect(store.scrollOf("e")).toBe("scroll")
    expect(store.asked("e")).toBe("preview")
    store.setAsked("e", "diff")
    expect(store.asked("e")).toBe("diff")
    expect(store.state("x")).toBeNull()
    expect(store.scrollOf("x")).toBeNull()
  })

  it("saveEntry goes through the editor's saver; none (or not editing): an error", async () => {
    const { store } = make(vi.fn())
    store.start("e", "/w/a.ts", undefined, "a", "h0")
    expect(await store.saveEntry("e")).toBe("error") // the editor's chunk isn't loaded
    store.setSaver(async () => "saved")
    expect(await store.saveEntry("e")).toBe("saved")
    expect(await store.saveEntry("x")).toBe("error")
  })

  it("lists the unsaved files' paths", () => {
    const { store } = make(vi.fn())
    store.start("e", "/w/a.ts", undefined, "a", "h0")
    store.start("f", "/w/b.ts", undefined, "b", "h1")
    store.setDirty("f", true)
    expect(store.unsavedPaths()).toEqual(["/w/b.ts"])
    expect(store.isUnsaved("e")).toBe(false)
    expect(store.path("e")).toBe("/w/a.ts")
  })

  it("settled waits for a tracked save, whole", async () => {
    const { store } = make(vi.fn())
    let finish!: () => void
    store.track("e", new Promise<void>((r) => (finish = r)))
    let done = false
    void store.settledAll().then(() => (done = true))
    await Promise.resolve()
    expect(done).toBe(false)
    finish()
    await store.settled("e")
    await store.settledAll()
    expect(done).toBe(true)
  })
})
