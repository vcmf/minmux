import { describe, it, expect } from "vitest"
import { makeTab, withFocus } from "./tab-focus"
import { addSurface, makeLeaf, removeNode, splitNode } from "./pane-tree"
import { OBJECT_PREFIX } from "./entries"

const folder = `${OBJECT_PREFIX}f1`

describe("tab focus", () => {
  it("a new tab focuses its terminal", () => {
    const t = makeTab("t", "", makeLeaf("p", "a"), "a")
    expect(t).toMatchObject({ activeEntryId: "a", activeSessionId: "a" })
  })

  it("focusing a terminal moves both and shows it", () => {
    const t = makeTab("t", "", addSurface(makeLeaf("p", "a"), "p", "b"), "b")
    const f = withFocus(t, "a")
    expect(f).toMatchObject({ activeEntryId: "a", activeSessionId: "a" })
    expect(f.root).toMatchObject({ activeEntryId: "a" })
  })

  it("returns the same tab when nothing changes", () => {
    const t = makeTab("t", "", makeLeaf("p", "a"), "a")
    expect(withFocus(t, "a")).toBe(t)
  })

  it("focusing a folder keeps the tab's terminal", () => {
    const t = makeTab("t", "", addSurface(makeLeaf("p", "a"), "p", folder), "a")
    const f = withFocus(t, folder)
    expect(f).toMatchObject({ activeEntryId: folder, activeSessionId: "a" })
  })

  it("the tab's terminal moves on when it left the tree", () => {
    const root = splitNode(addSurface(makeLeaf("p", "a"), "p", folder), "a", "row", "b", "s", "q")
    const t = makeTab("t", "", root, "a")
    const f = withFocus(t, folder, removeNode(root, "a")!)
    expect(f).toMatchObject({ activeEntryId: folder, activeSessionId: "b" })
  })

  it("select=false focuses without changing what the pane shows", () => {
    const root = addSurface(makeLeaf("p", "a"), "p", "b")
    const t = makeTab("t", "", root, "b")
    const f = withFocus(t, "a", root, false)
    expect(f.root).toBe(root)
    expect(f.activeEntryId).toBe("a")
  })
})

describe("tab focus: stale ids", () => {
  it("focusing an entry that isn't in the tab changes nothing", () => {
    const t = makeTab("t", "", makeLeaf("p", "a"), "a")
    expect(withFocus(t, "gone")).toBe(t)
  })
})
