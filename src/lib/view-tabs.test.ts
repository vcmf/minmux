import { describe, it, expect } from "vitest"
import {
  leavingView,
  parseViews,
  shownTerminalTab,
  viewDot,
  withView,
  withoutView,
  type ViewKind,
} from "./view-tabs"
import { reduceAgentEvents } from "./agent-graph"
import type { Tab } from "../types"

const tab = (id: string): Tab => ({
  id,
  title: id,
  root: { type: "leaf", id: `p-${id}`, entryIds: [`s-${id}`], activeEntryId: `s-${id}` },
  activeEntryId: `s-${id}`,
  activeSessionId: `s-${id}`,
})

describe("view tabs", () => {
  it("opens a kind once, at the end, and keeps the reference when it's there", () => {
    const none: ViewKind[] = []
    const one = withView(none, "fleet")
    expect(one).toEqual(["fleet"])
    expect(withView(one, "fleet")).toBe(one)
  })

  it("closes a kind, and keeps the reference when it wasn't open", () => {
    const none: ViewKind[] = []
    expect(withoutView(["fleet"], "fleet")).toEqual([])
    expect(withoutView(none, "fleet")).toBe(none)
  })

  it("reads saved views back: known kinds only, each once", () => {
    expect(parseViews(["fleet", "pulls", "fleet", 3])).toEqual(["fleet"])
    expect(parseViews(undefined)).toEqual([])
    expect(parseViews("fleet")).toEqual([])
  })

  it("the terminal tab on screen is the context tab, none while a view covers it", () => {
    const tabs = [tab("a"), tab("b")]
    expect(shownTerminalTab({ tabs, activeTabId: "b", activeView: null })?.id).toBe("b")
    expect(shownTerminalTab({ tabs, activeTabId: "b", activeView: "fleet" })).toBeUndefined()
  })

  describe("leavingView", () => {
    const shown = { activeTabId: "a", activeView: "fleet" as const }

    it("leaves the view when activeTabId moves to another tab", () => {
      expect(leavingView(shown, { activeTabId: "b" })).toEqual({
        activeTabId: "b",
        activeView: null,
      })
    })

    it("keeps it when activeTabId is set to the same tab (closing another tab)", () => {
      const next = { activeTabId: "a", tabs: [] }
      expect(leavingView(shown, next)).toBe(next)
    })

    it("keeps it for updates that don't touch activeTabId", () => {
      const next = { tabs: [] as Tab[] }
      expect(leavingView(shown, next)).toBe(next)
    })

    it("leaves an update that sets activeView itself alone", () => {
      const next = { activeTabId: "b", activeView: "fleet" as const }
      expect(leavingView(shown, next)).toBe(next)
    })

    it("does nothing when no view is shown", () => {
      const next = { activeTabId: "b" }
      expect(leavingView({ activeTabId: "a", activeView: null }, next)).toBe(next)
    })
  })

  it("the fleet's dot: amber while any agent needs you, green while any works", () => {
    const working = reduceAgentEvents([
      { event: "SessionStart", sessionId: "s1", cwd: "/r", paneId: "p1" },
      { event: "UserPromptSubmit", sessionId: "s1" },
    ])
    expect(viewDot("fleet", working)).toBe("accent")
    const waiting = reduceAgentEvents([
      { event: "SessionStart", sessionId: "s1", cwd: "/r", paneId: "p1" },
      { event: "UserPromptSubmit", sessionId: "s1" },
      { event: "SessionStart", sessionId: "s2", cwd: "/r", paneId: "p2" },
      { event: "UserPromptSubmit", sessionId: "s2" },
      { event: "PermissionRequest", sessionId: "s2", toolName: "Bash" },
    ])
    expect(viewDot("fleet", waiting)).toBe("amber")
    expect(viewDot("fleet", reduceAgentEvents([]))).toBe("")
  })
})
