import { describe, it, expect } from "vitest"
import {
  assembleDiff,
  changeBars,
  changesUnder,
  diffSides,
  gitFileFor,
  hasDiffToggle,
  opensOnDiff,
  relTo,
} from "./git-file"
import type { DiffLine, GitFile, GitStatus } from "./ipc"

const f = (path: string, status: GitFile["status"]): GitFile =>
  ({ path, name: path.split("/").pop()!, dir: ".", status, add: 1, del: 0 }) as GitFile
const git = (files: GitFile[]): GitStatus =>
  ({
    isRepo: true,
    root: "/w/rts",
    branch: "main",
    ahead: 0,
    behind: 0,
    files,
    add: 0,
    del: 0,
  }) as GitStatus

describe("git-file", () => {
  it("relTo and gitFileFor find a file in its repo", () => {
    expect(relTo("/w/rts/", "/w/rts/src/a.ts")).toBe("src/a.ts")
    expect(relTo("/w/rts", "/w/other/a.ts")).toBeUndefined()
    expect(relTo("C:\\w\\rts", "C:\\w\\rts\\src\\a.ts")).toBe("src/a.ts")
    expect(relTo("C:/w/rts", "c:\\w\\rts\\a.ts")).toBe("a.ts") // a drive letter in either case
    const g = git([f("src/a.ts", "M")])
    expect(gitFileFor(g, "/w/rts/src/a.ts")!.status).toBe("M")
    expect(gitFileFor(g, "/w/rts/src/b.ts")).toBeUndefined()
  })

  it("changesUnder: the folder's own, or the whole repo's at its root", () => {
    const g = git([f("src/a.ts", "M"), f("docs/b.md", "?"), f("README.md", "M")])
    expect(changesUnder(g, "/w/rts/src").map((x) => x.path)).toEqual(["src/a.ts"])
    expect(changesUnder(g, "/w/rts/")).toHaveLength(3)
  })

  it("which view a file opens on, and which offer a toggle", () => {
    expect(opensOnDiff("M", true)).toBe(true)
    expect(opensOnDiff("M", false)).toBe(false)
    expect(opensOnDiff("D", false)).toBe(true)
    expect(opensOnDiff("?", true)).toBe(false)
    expect(hasDiffToggle("M")).toBe(true)
    expect(hasDiffToggle("A")).toBe(false)
    expect(hasDiffToggle("R")).toBe(false) // no old path to pair a rename with
    expect(opensOnDiff("R", true)).toBe(false)
  })

  it("change bars: modified where adds replace deletes, added beyond, deleted above the next", () => {
    const lines: DiffLine[] = [
      { type: "hunk", text: "@@" },
      { type: "context", text: "a", oldNo: 1, newNo: 1 },
      { type: "del", text: "b", oldNo: 2 },
      { type: "add", text: "B", newNo: 2 },
      { type: "add", text: "C", newNo: 3 },
      { type: "context", text: "d", oldNo: 3, newNo: 4 },
      { type: "del", text: "e", oldNo: 4 },
      { type: "context", text: "f", oldNo: 5, newNo: 5 },
    ]
    expect([...changeBars(lines)]).toEqual([
      [2, "mod"],
      [3, "add"],
      [5, "del"],
    ])
  })

  it("diff sides carry context on both; assembled back line by line", () => {
    const lines: DiffLine[] = [
      { type: "hunk", text: "@@ -1 +1 @@" },
      { type: "context", text: "x", oldNo: 1, newNo: 1 },
      { type: "del", text: "old", oldNo: 2 },
      { type: "add", text: "new", newNo: 2 },
    ]
    const s = diffSides(lines)
    expect(s.old).toBe("x\nold")
    expect(s.new).toBe("x\nnew")
    const html = assembleDiff(s.at, ["X", "OLD"], ["X", "NEW"], () => "@@")
    expect(html).toEqual(["@@", "X", "OLD", "NEW"])
  })
})
