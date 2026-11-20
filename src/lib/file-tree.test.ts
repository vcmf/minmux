import { describe, it, expect } from "vitest"
import {
  joinPath,
  baseName,
  hasListing,
  shownOpenDirs,
  visibleRows,
  type FileTreeState,
} from "./file-tree"
import type { DirListing } from "./dir-listing"

const listing = (names: [string, boolean][], truncated = false): DirListing => ({
  entries: names.map(([name, isDir]) => ({ name, isDir })),
  truncated,
})

// Builders (the folder tabs keep listings in lib/listing-store, expansion in the store).
const emptyTree = (root: string): FileTreeState => ({ root, listings: {}, expanded: new Set() })
const setListing = (s: FileTreeState, dir: string, l: DirListing): FileTreeState => ({
  ...s,
  listings: { ...s.listings, [dir]: l },
})
const showAllIn = (s: FileTreeState, dir: string): FileTreeState => ({
  ...s,
  showAll: new Set([...(s.showAll ?? []), dir]),
})
const toggle = (s: FileTreeState, dir: string): FileTreeState => {
  const expanded = new Set(s.expanded)
  if (!expanded.delete(dir)) expanded.add(dir)
  return { ...s, expanded }
}

describe("path helpers", () => {
  it("joinPath avoids a double slash at the root", () => {
    expect(joinPath("/repo", "src")).toBe("/repo/src")
    expect(joinPath("/", "src")).toBe("/src")
    expect(joinPath("/repo/", "src")).toBe("/repo/src")
  })
  it("baseName returns the last segment", () => {
    expect(baseName("/a/b/c")).toBe("c")
    expect(baseName("C:\\work\\rts")).toBe("rts") // a Windows path too
    expect(baseName("/a/b/")).toBe("b")
    expect(baseName("/")).toBe("/")
  })
})

describe("tree state", () => {
  it("a folder whose read failed shows a note, not an empty folder", () => {
    const s = setListing(emptyTree("/repo"), "/repo", {
      entries: [],
      truncated: false,
      error: true,
    })
    expect(visibleRows(s)).toEqual([
      {
        path: "note:/repo",
        name: "Couldn't read this folder",
        depth: 0,
        kind: "note",
        expanded: false,
      },
    ])
  })
  it("hasListing: a failed read's listing doesn't count", () => {
    const failed = { entries: [], truncated: false, error: true }
    expect(hasListing(emptyTree("/r"), "/r")).toBe(false)
    expect(hasListing(setListing(emptyTree("/r"), "/r", failed), "/r")).toBe(false)
    expect(hasListing(setListing(emptyTree("/r"), "/r", listing([["a", false]])), "/r")).toBe(true)
  })
})

describe("visibleRows", () => {
  // /repo: [src/ (dir), README.md]; /repo/src: [app.ts]
  const base = () =>
    setListing(
      emptyTree("/repo"),
      "/repo",
      listing([
        ["src", true],
        ["README.md", false],
      ]),
    )

  it("root only when nothing is expanded", () => {
    const rows = visibleRows(base())
    expect(rows.map((r) => [r.name, r.depth, r.kind])).toEqual([
      ["src", 0, "dir"],
      ["README.md", 0, "file"],
    ])
  })

  it("expanding a loaded dir shows its children at depth+1", () => {
    let s = base()
    s = toggle(s, "/repo/src")
    s = setListing(s, "/repo/src", listing([["app.ts", false]]))
    const rows = visibleRows(s)
    expect(rows.map((r) => [r.name, r.depth])).toEqual([
      ["src", 0],
      ["app.ts", 1],
      ["README.md", 0],
    ])
  })

  it("an expanded but not-yet-loaded dir shows no children", () => {
    const s = toggle(base(), "/repo/src") // expanded, no listing for it
    const rows = visibleRows(s)
    expect(rows.find((r) => r.name === "src")!.expanded).toBe(true)
    expect(rows.some((r) => r.depth === 1)).toBe(false) // nothing under it yet
  })

  it("collapsing hides children again", () => {
    let s = base()
    s = toggle(s, "/repo/src")
    s = setListing(s, "/repo/src", listing([["app.ts", false]]))
    s = toggle(s, "/repo/src") // collapse
    expect(visibleRows(s).some((r) => r.name === "app.ts")).toBe(false)
  })

  it("a truncated listing appends a non-interactive note row with a clean key", () => {
    const s = setListing(emptyTree("/repo"), "/repo", listing([["a", false]], true))
    const rows = visibleRows(s)
    const last = rows[rows.length - 1]!
    expect(last.kind).toBe("note")
    expect(last.path).toBe("note:/repo") // stable, printable key (no NUL byte)
  })

  it("a big folder (>100 entries) previews its first 10, then a 'N more' row; Show all lifts it", () => {
    const big = Array.from(
      { length: 150 },
      (_, i) => [`f${String(i).padStart(3, "0")}`, false] as [string, boolean],
    )
    let s = setListing(emptyTree("/repo"), "/repo", { ...listing(big), total: 150 })
    let rows = visibleRows(s)
    expect(rows).toHaveLength(11)
    expect(rows[10]).toMatchObject({ kind: "more", name: "140 more", dir: "/repo", hidden: 140 })
    s = showAllIn(s, "/repo")
    rows = visibleRows(s)
    expect(rows).toHaveLength(150)
    expect(rows.some((r) => r.kind === "more")).toBe(false)
  })

  it("a folder past the backend cap ends with a note row counting what's left", () => {
    const capped = Array.from({ length: 50 }, (_, i) => [`f${i}`, false] as [string, boolean])
    const s = showAllIn(
      setListing(emptyTree("/r"), "/r", { ...listing(capped, true), total: 1240 }),
      "/r",
    )
    const rows = visibleRows(s)
    const last = rows[rows.length - 1]!
    expect(last).toMatchObject({ kind: "note", name: "1,190 more", path: "note:/r" })
  })

  it("nothing renders before the root listing arrives", () => {
    expect(visibleRows(emptyTree("/repo"))).toEqual([])
  })
})

describe("shownOpenDirs", () => {
  it("skips expanded folders hidden under a collapsed parent", () => {
    let s = setListing(
      emptyTree("/r"),
      "/r",
      listing([
        ["a", true],
        ["b", true],
      ]),
    )
    s = setListing(s, "/r/a", listing([["deep", true]]))
    s = { ...s, expanded: new Set(["/r/a", "/r/a/deep", "/r/b"]) }
    expect(shownOpenDirs(s)).toEqual(["/r", "/r/a", "/r/a/deep", "/r/b"])
    s = { ...s, expanded: new Set(["/r/a/deep", "/r/b"]) } // /r/a collapsed
    expect(shownOpenDirs(s)).toEqual(["/r", "/r/b"])
  })
})
