import { describe, expect, it } from "vitest"
import { openTarget } from "./cli-open"
import { makeLeaf } from "./pane-tree"
import type { Tab } from "../types"

const tab = (id: string, title: string): Tab => ({
  id,
  title,
  root: makeLeaf(`p-${id}`, `s-${id}`),
  activeSessionId: `s-${id}`,
})
const tabs = [tab("a", ""), tab("b", "wave 1")]

describe("openTarget", () => {
  it("a titled tab by its exact title, else a new tab with that title", () => {
    expect(openTarget(tabs, "a", { tab: "wave 1" })).toEqual({ tabId: "b", direction: "row" })
    expect(openTarget(tabs, "a", { tab: "Wave 1" })).toEqual({ newTab: "Wave 1" })
  })

  it("no title: the active tab; none → a new untitled tab", () => {
    expect(openTarget(tabs, "a", {})).toEqual({ tabId: "a", direction: "row" })
    expect(openTarget(tabs, null, {})).toEqual({ newTab: "" })
    expect(openTarget([], null, { split: "down" })).toEqual({ newTab: "" })
  })

  it("--split down splits below", () => {
    expect(openTarget(tabs, "a", { split: "down" })).toEqual({ tabId: "a", direction: "column" })
  })
})
