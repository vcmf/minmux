import { describe, it, expect } from "vitest"
import { previewEntries, toDirListing, READDIR_CAP } from "./dir-listing"
import type { DirEntry } from "./dir-listing"

const e = (name: string, isDir = false): DirEntry => ({ name, isDir })

describe("toDirListing", () => {
  it("puts directories first, then files, each alphabetical", () => {
    const out = toDirListing([e("z.ts"), e("src", true), e("a.ts"), e("lib", true)])
    expect(out.entries.map((x) => x.name)).toEqual(["lib", "src", "a.ts", "z.ts"])
  })

  it("hides .git", () => {
    const out = toDirListing([e(".git", true), e("README.md")])
    expect(out.entries.map((x) => x.name)).toEqual(["README.md"])
  })

  it("keeps other dotfiles", () => {
    const out = toDirListing([e(".env"), e(".github", true)])
    expect(out.entries.map((x) => x.name)).toEqual([".github", ".env"])
  })

  it("caps and flags truncation (boundary-exact)", () => {
    const many = Array.from({ length: 12 }, (_, i) => e(`f${i}`))
    const a = toDirListing(many, 10)
    expect(a.entries).toHaveLength(10)
    expect(a.truncated).toBe(true)

    const exact = toDirListing(
      Array.from({ length: 10 }, (_, i) => e(`f${i}`)),
      10,
    )
    expect(exact.entries).toHaveLength(10)
    expect(exact.truncated).toBe(false) // exactly at the cap is NOT truncated
  })

  it("empty input → empty, not truncated", () => {
    expect(toDirListing([])).toEqual({ entries: [], truncated: false, total: 0 })
  })

  it("defaults to READDIR_CAP", () => {
    const many = Array.from({ length: READDIR_CAP + 1 }, (_, i) => e(`f${i}`))
    expect(toDirListing(many).truncated).toBe(true)
  })
})

describe("previewEntries", () => {
  const xs = Array.from({ length: 150 }, (_, i) => i)
  it("a folder of ≤100 shows everything; a bigger one previews 10 until 'show all'", () => {
    expect(previewEntries(xs.slice(0, 100), 100, false)).toEqual({
      shown: xs.slice(0, 100),
      hidden: 0,
    })
    expect(previewEntries(xs, 150, false)).toEqual({ shown: xs.slice(0, 10), hidden: 140 })
    expect(previewEntries(xs, 150, true)).toEqual({ shown: xs, hidden: 0 })
    expect(previewEntries(xs.slice(0, 50), 1240, true).hidden).toBe(1190) // past the backend cap
  })
})
