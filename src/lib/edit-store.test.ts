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
})
