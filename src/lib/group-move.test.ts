import { describe, it, expect } from "vitest"
import type { Tab } from "../types"
import { makeLeaf, allSessionIds, type MoveTarget } from "./pane-tree"
import { canDrop, moveTerminal, tabOf } from "./group-move"

const leaf = makeLeaf
const tab = (id: string, root: Tab["root"], active?: string): Tab => ({
  id,
  title: "",
  root,
  activeSessionId: active ?? allSessionIds(root)[0]!,
})
const split = (id: string, a: Tab["root"], b: Tab["root"]): Tab["root"] => ({
  type: "split",
  id,
  direction: "row",
  children: [a, b],
})
const ids = { splitId: "S", paneId: "P", tabId: "T" }
const order = (tabs: Tab[]) => tabs.map((t) => `${t.id}:${allSessionIds(t.root).join(",")}`)

// A = [a1 | a2] (a2 focused), B = [b1], C = [c1]
const tabs = (): Tab[] => [
  tab("A", split("sA", leaf("pa1", "a1"), leaf("pa2", "a2")), "a2"),
  tab("B", leaf("pb1", "b1")),
  tab("C", leaf("pc1", "c1")),
]

describe("moveTerminal — join another group", () => {
  it("lands as a pane on its right; that group becomes active, the terminal its focus", () => {
    const r = moveTerminal(tabs(), "a2", { kind: "join", tabId: "B" }, ids)!
    expect(order(r.tabs)).toEqual(["A:a1", "B:b1,a2", "C:c1"])
    expect(r.activeTabId).toBe("B")
    const b = r.tabs[1]!
    expect(b.activeSessionId).toBe("a2")
    expect(b.root).toMatchObject({ type: "split", direction: "row", id: "S" })
    expect(r.tabs[0]!.activeSessionId).toBe("a1") // the source refocuses what's left
  })

  it("a group's last terminal merges it into the other; the empty group disappears", () => {
    const r = moveTerminal(tabs(), "b1", { kind: "join", tabId: "C" }, ids)!
    expect(order(r.tabs)).toEqual(["A:a1,a2", "C:c1,b1"])
  })

  it("onto its own group: nothing", () => {
    expect(moveTerminal(tabs(), "a1", { kind: "join", tabId: "A" }, ids)).toBeNull()
    expect(canDrop(tabs(), "a1", { kind: "join", tabId: "A" })).toBe(false)
  })
})

describe("moveTerminal — a pane of another group (after spring-loading it open)", () => {
  it("an edge zone splits that pane", () => {
    const target: MoveTarget = { paneId: "pc1", zone: "bottom" }
    const r = moveTerminal(tabs(), "a1", { kind: "pane", tabId: "C", target }, ids)!
    expect(r.tabs[2]!.root).toMatchObject({
      type: "split",
      direction: "column",
      children: [{ id: "pc1" }, { id: "P", sessionIds: ["a1"] }],
    })
  })

  it("its tab strip: joins that pane's tabs at the slot", () => {
    const target: MoveTarget = { paneId: "pb1", index: 0 }
    const r = moveTerminal(tabs(), "a1", { kind: "pane", tabId: "B", target }, ids)!
    expect(r.tabs[1]!.root).toMatchObject({ sessionIds: ["a1", "b1"], activeSessionId: "a1" })
  })

  it("a pane that went away mid-drag: nothing", () => {
    const target: MoveTarget = { paneId: "gone", zone: "center" }
    expect(moveTerminal(tabs(), "a1", { kind: "pane", tabId: "B", target }, ids)).toBeNull()
  })
})

describe("moveTerminal — a new group", () => {
  it("a terminal from a split leaves it as a group of its own at the gap", () => {
    const r = moveTerminal(tabs(), "a2", { kind: "new", insertAt: 2 }, ids)!
    expect(order(r.tabs)).toEqual(["A:a1", "B:b1", "T:a2", "C:c1"])
    expect(r.activeTabId).toBe("T")
    expect(r.tabs[2]!.activeSessionId).toBe("a2")
  })

  it("at the very end", () => {
    const r = moveTerminal(tabs(), "a1", { kind: "new", insertAt: 3 }, ids)!
    expect(order(r.tabs)).toEqual(["A:a2", "B:b1", "C:c1", "T:a1"])
  })

  it("a group's only terminal: the group just moves (a reorder)", () => {
    const r = moveTerminal(tabs(), "c1", { kind: "new", insertAt: 0 }, ids)!
    expect(order(r.tabs)).toEqual(["C:c1", "A:a1,a2", "B:b1"])
    expect(r.activeTabId).toBe("C")
  })

  it("…and next to itself, nothing", () => {
    expect(moveTerminal(tabs(), "b1", { kind: "new", insertAt: 1 }, ids)).toBeNull()
    expect(moveTerminal(tabs(), "b1", { kind: "new", insertAt: 2 }, ids)).toBeNull()
  })
})

describe("tabOf", () => {
  it("finds the group holding a terminal (hidden surfaces too)", () => {
    expect(tabOf(tabs(), "a1")?.id).toBe("A")
    expect(tabOf(tabs(), "nope")).toBeUndefined()
  })
})
