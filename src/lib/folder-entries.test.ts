import { describe, it, expect } from "vitest"
import { EMPTY_VIEW, folderChoices, objectId, placeOf, toggleExpanded } from "./folder-entries"
import { isTerminalEntry } from "./entries"

describe("folder entries", () => {
  it("an object id is never a terminal", () => {
    expect(isTerminalEntry(objectId("x"))).toBe(false)
  })

  it("one folder when from, in and edits agree", () => {
    expect(folderChoices("/w/rts", "/w/rts/", { shown: "/w/rts", more: [] })).toEqual([
      { label: "from", path: "/w/rts" },
    ])
  })

  it("the distinct ones, labelled like the sidebar, in its order", () => {
    expect(
      folderChoices("/w/rts", "/w/rts-e", { shown: "/w/rts-e", more: ["/w/rts-ci", "/w/rts"] }),
    ).toEqual([
      { label: "from", path: "/w/rts" },
      { label: "in", path: "/w/rts-e" },
      { label: "edits", path: "/w/rts-ci" },
    ])
  })

  it("nothing known: none (an ssh pane has no local folder)", () => {
    expect(folderChoices(undefined, undefined, undefined)).toEqual([])
  })

  it("toggleExpanded keeps the same view when nothing changes", () => {
    const v = toggleExpanded(EMPTY_VIEW, "/a", true)
    expect(v.expanded).toEqual(["/a"])
    expect(toggleExpanded(v, "/a", true)).toBe(v)
    expect(toggleExpanded(v, "/a", false).expanded).toEqual([])
    expect(toggleExpanded(EMPTY_VIEW, "/a", false)).toBe(EMPTY_VIEW)
  })

  it("placeOf: a file's folder, a drive root kept as C:\\", () => {
    expect(placeOf({ kind: "file", path: "/w/a/b.ts" }).path).toBe("/w/a")
    expect(placeOf({ kind: "file", path: "/b.ts" }).path).toBe("/")
    expect(placeOf({ kind: "file", path: "C:\\notes.txt" }).path).toBe("C:\\")
    expect(placeOf({ kind: "folder", path: "/w" }).path).toBe("/w")
  })
})
