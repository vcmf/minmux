import { describe, it, expect, vi } from "vitest"
import { ListingStore } from "./listing-store"
import type { DirListing } from "./dir-listing"

const L = (...names: string[]): DirListing => ({
  entries: names.map((name) => ({ name, isDir: false })),
  truncated: false,
})

describe("ListingStore", () => {
  it("keeps the same object when a read changes nothing, and doesn't notify", () => {
    const s = new ListingStore()
    const fn = vi.fn()
    s.subscribe(fn)
    expect(s.set("", "/a", L("x"))).toBe(true)
    const before = s.get("")
    expect(s.set("", "/a", L("x"))).toBe(false)
    expect(s.get("")).toBe(before)
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it("a failed re-read keeps the listing", () => {
    const s = new ListingStore()
    s.set("", "/a", L("x"))
    expect(s.set("", "/a", { ...L(), error: true })).toBe(false)
    expect(s.get("")["/a"]!.entries).toHaveLength(1)
  })

  it("scopes keep the same path apart (a WSL distro vs the host)", () => {
    const s = new ListingStore()
    s.set("", "/home", L("host"))
    s.set("wsl:Ubuntu", "/home", L("linux"))
    expect(s.get("")["/home"]!.entries[0]!.name).toBe("host")
    expect(s.get("wsl:Ubuntu")["/home"]!.entries[0]!.name).toBe("linux")
  })

  it("past the cap, the least recently updated folder goes", () => {
    const s = new ListingStore(2)
    s.set("", "/a", L("1"))
    s.set("", "/b", L("1"))
    s.set("", "/a", L("2")) // /a is now the newest
    s.set("", "/c", L("1"))
    expect(Object.keys(s.get("")).sort()).toEqual(["/a", "/c"])
  })

  it("an unchanged re-read still counts as a use (a folder on screen never ages out)", () => {
    const s = new ListingStore(2)
    s.set("", "/shown", L("1"))
    s.set("", "/b", L("1"))
    s.set("", "/shown", L("1")) // re-read, unchanged
    s.set("", "/c", L("1"))
    expect(Object.keys(s.get("")).sort()).toEqual(["/c", "/shown"])
  })
})
