import { describe, it, expect } from "vitest"
import {
  showAllIn,
  joinPath,
  baseName,
  emptyTree,
  setListing,
  hasListing,
  toggleDir,
  visibleRows,
  openDirs,
  FileTreeCache,
  type FileTreeState,
} from "./file-tree"
import type { DirListing } from "./dir-listing"

const listing = (names: [string, boolean][], truncated = false): DirListing => ({
  entries: names.map(([name, isDir]) => ({ name, isDir })),
  truncated,
})

describe("path helpers", () => {
  it("joinPath avoids a double slash at the root", () => {
    expect(joinPath("/repo", "src")).toBe("/repo/src")
    expect(joinPath("/", "src")).toBe("/src")
    expect(joinPath("/repo/", "src")).toBe("/repo/src")
  })
  it("baseName returns the last segment", () => {
    expect(baseName("/a/b/c")).toBe("c")
    expect(baseName("/a/b/")).toBe("b")
    expect(baseName("/")).toBe("/")
  })
})

describe("tree state — immutability", () => {
  it("emptyTree is empty", () => {
    const s = emptyTree("/repo")
    expect(s.root).toBe("/repo")
    expect(s.listings).toEqual({})
    expect([...s.expanded]).toEqual([])
  })
  it("a failed re-read keeps the cached listing, and a failed folder is read again on expand", () => {
    const failed = { entries: [], truncated: false, error: true }
    const s1 = setListing(emptyTree("/repo"), "/repo/src", listing([["a.ts", false]]))
    expect(setListing(s1, "/repo/src", failed)).toBe(s1)
    const s2 = setListing(emptyTree("/repo"), "/repo/src", failed) // first read failed
    expect(toggleDir(s2, "/repo/src").needsLoad).toBe("/repo/src")
  })
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
  it("setListing with an unchanged listing returns the same state (no re-render)", () => {
    const s1 = setListing(emptyTree("/repo"), "/repo", listing([["a.ts", false]]))
    expect(setListing(s1, "/repo", listing([["a.ts", false]]))).toBe(s1)
    expect(setListing(s1, "/repo", listing([["b.ts", false]]))).not.toBe(s1)
    expect(setListing(s1, "/repo", listing([["a.ts", true]]))).not.toBe(s1)
    expect(setListing(s1, "/repo", { ...listing([["a.ts", false]]), total: 9 })).not.toBe(s1)
  })
  it("hasListing: a failed read's listing doesn't count", () => {
    const failed = { entries: [], truncated: false, error: true }
    expect(hasListing(emptyTree("/r"), "/r")).toBe(false)
    expect(hasListing(setListing(emptyTree("/r"), "/r", failed), "/r")).toBe(false)
    expect(hasListing(setListing(emptyTree("/r"), "/r", listing([["a", false]])), "/r")).toBe(true)
  })
  it("setListing returns a new state and doesn't mutate the input", () => {
    const s0 = emptyTree("/repo")
    const s1 = setListing(s0, "/repo", listing([["a.ts", false]]))
    expect(s1).not.toBe(s0)
    expect(s0.listings).toEqual({}) // input untouched
    expect(s1.listings["/repo"]!.entries).toHaveLength(1)
  })
})

describe("toggleDir", () => {
  it("expanding an uncached dir asks for a load", () => {
    const s = emptyTree("/repo")
    const { state, needsLoad } = toggleDir(s, "/repo/src")
    expect(needsLoad).toBe("/repo/src")
    expect(state.expanded.has("/repo/src")).toBe(true)
    expect(s.expanded.has("/repo/src")).toBe(false) // input untouched
  })
  it("expanding an already-cached dir re-reads it (the cached listing may be stale)", () => {
    const s = setListing(emptyTree("/repo"), "/repo/src", listing([["x.ts", false]]))
    const { needsLoad, state } = toggleDir(s, "/repo/src")
    expect(needsLoad).toBe("/repo/src")
    expect(state.expanded.has("/repo/src")).toBe(true)
  })
  it("collapsing removes it and needs no load", () => {
    const s = toggleDir(emptyTree("/repo"), "/repo/src").state
    const { state, needsLoad } = toggleDir(s, "/repo/src")
    expect(needsLoad).toBeNull()
    expect(state.expanded.has("/repo/src")).toBe(false)
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
    s = toggleDir(s, "/repo/src").state
    s = setListing(s, "/repo/src", listing([["app.ts", false]]))
    const rows = visibleRows(s)
    expect(rows.map((r) => [r.name, r.depth])).toEqual([
      ["src", 0],
      ["app.ts", 1],
      ["README.md", 0],
    ])
  })

  it("an expanded but not-yet-loaded dir shows no children", () => {
    const s = toggleDir(base(), "/repo/src").state // expanded, no listing for it
    const rows = visibleRows(s)
    expect(rows.find((r) => r.name === "src")!.expanded).toBe(true)
    expect(rows.some((r) => r.depth === 1)).toBe(false) // nothing under it yet
  })

  it("collapsing hides children again", () => {
    let s = base()
    s = toggleDir(s, "/repo/src").state
    s = setListing(s, "/repo/src", listing([["app.ts", false]]))
    s = toggleDir(s, "/repo/src").state // collapse
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

describe("openDirs", () => {
  it("is the root plus expanded dirs, root not duplicated", () => {
    let s = setListing(emptyTree("/repo"), "/repo", listing([["src", true]]))
    s = toggleDir(s, "/repo/src").state
    expect(openDirs(s).sort()).toEqual(["/repo", "/repo/src"])
  })
})

describe("FileTreeCache (LRU)", () => {
  it("replace updates an entry without making it most recently used", () => {
    const c = new FileTreeCache(2)
    const st = (r: string) => emptyTree(r)
    c.set("/a", st("/a"))
    c.set("/b", st("/b"))
    c.replace("/a", setListing(st("/a"), "/a", listing([["x", false]]))) // a background result
    c.set("/c", st("/c")) // over capacity → /a is still the LRU and goes
    expect(c.has("/a")).toBe(false)
    expect(c.has("/b")).toBe(true)
  })

  const st = (root: string): FileTreeState => emptyTree(root)

  it("get/set round-trips and get marks MRU", () => {
    const c = new FileTreeCache(2)
    c.set("/a", st("/a"))
    c.set("/b", st("/b"))
    expect(c.get("/a")?.root).toBe("/a") // touches /a → MRU, /b now LRU
    c.set("/c", st("/c")) // over capacity → evict LRU (/b)
    expect(c.has("/b")).toBe(false)
    expect(c.has("/a")).toBe(true)
    expect(c.has("/c")).toBe(true)
  })

  it("evicts the least-recently-used first", () => {
    const c = new FileTreeCache(2)
    c.set("/a", st("/a"))
    c.set("/b", st("/b"))
    c.set("/c", st("/c")) // evicts /a (oldest)
    expect(c.keys()).toEqual(["/b", "/c"]) // LRU → MRU
    expect(c.has("/a")).toBe(false)
  })

  it("re-setting an existing key updates it and doesn't evict", () => {
    const c = new FileTreeCache(2)
    c.set("/a", st("/a"))
    c.set("/b", st("/b"))
    c.set("/a", setListing(st("/a"), "/a", listing([["x", false]]))) // update /a → MRU
    expect(c.size).toBe(2)
    expect(c.keys()).toEqual(["/b", "/a"])
    expect(c.get("/a")?.listings["/a"]).toBeDefined()
  })

  it("capacity 1 keeps only the newest", () => {
    const c = new FileTreeCache(1)
    c.set("/a", st("/a"))
    c.set("/b", st("/b"))
    expect(c.keys()).toEqual(["/b"])
    expect(c.size).toBe(1)
  })

  it("missing key → undefined", () => {
    expect(new FileTreeCache(2).get("/nope")).toBeUndefined()
  })
})
