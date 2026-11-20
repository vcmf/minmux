import { describe, it, expect, vi, beforeEach } from "vitest"
import { focusActiveEntry, focusEntry } from "./refocus-terminal"
import { TerminalManager } from "../terminal/terminal-manager"
import { useStore } from "../store"
import { resetStore, testShell } from "../test/helpers"

vi.mock("../terminal/terminal-manager", () => ({ TerminalManager: { focus: vi.fn() } }))

beforeEach(() => {
  resetStore()
  vi.clearAllMocks()
  document.body.innerHTML = ""
})

describe("focusEntry", () => {
  it("a terminal takes the keyboard through TerminalManager", () => {
    focusEntry("a-session")
    expect(TerminalManager.focus).toHaveBeenCalledWith("a-session")
  })

  it("a folder entry's view element takes it", () => {
    const el = document.createElement("div")
    el.tabIndex = -1
    el.dataset.entry = "obj-1"
    document.body.appendChild(el)
    focusEntry("obj-1")
    expect(document.activeElement).toBe(el)
    expect(TerminalManager.focus).not.toHaveBeenCalled()
  })

  it("focusActiveEntry follows the active tab's focus", () => {
    useStore.getState().newTab(testShell)
    focusActiveEntry()
    expect(TerminalManager.focus).toHaveBeenCalledWith(useStore.getState().tabs[0]!.activeEntryId)
  })
})
