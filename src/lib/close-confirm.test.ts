import { describe, it, expect } from "vitest"
import {
  tabCloseConfirm,
  terminalCloseConfirm,
  closeConfirmText,
  confirmStillValid,
  unsavedCloseConfirm,
} from "./close-confirm"

const idle = (id: string) => ({ id, running: false, agent: undefined })

describe("tabCloseConfirm", () => {
  it("a single idle terminal closes right away", () => {
    expect(tabCloseConfirm("t", "term", [idle("a")])).toBeNull()
    expect(tabCloseConfirm("t", "term", [])).toBeNull()
  })
  it("more than one terminal always asks, running or not", () => {
    expect(tabCloseConfirm("t", "term", [idle("a"), idle("b")])).toMatchObject({
      kind: "tab",
      count: 2,
      agents: [],
    })
  })
  it("a single terminal asks when it's running a command or Claude", () => {
    expect(
      tabCloseConfirm("t", "term", [{ id: "a", running: true, agent: undefined }]),
    ).not.toBeNull()
    expect(
      tabCloseConfirm("t", "term", [{ id: "a", running: false, agent: "claude" }]),
    ).toMatchObject({
      agents: ["claude"],
    })
  })
})

describe("terminalCloseConfirm", () => {
  it("asks only while the terminal is running", () => {
    expect(terminalCloseConfirm("t", "zsh", idle("a"))).toBeNull()
    expect(terminalCloseConfirm("t", "zsh", { id: "a", running: true, agent: undefined })).toEqual({
      kind: "terminal",
      tabId: "t",
      sessionId: "a",
      title: "zsh",
      agent: undefined,
    })
  })
})

describe("closeConfirmText", () => {
  it("says what will close and mentions Claude", () => {
    const tab = closeConfirmText({
      kind: "tab",
      tabId: "t",
      title: "term",
      count: 3,
      agents: ["claude"],
    })
    expect(tab.title).toBe('Close "term"?')
    expect(tab.body).toBe(
      "3 terminals will close and whatever runs in them stops. 1 is running Claude.",
    )
    expect(tab.action).toBe("Close session")
    const one = closeConfirmText({ kind: "tab", tabId: "t", title: "x", count: 1, agents: [] })
    expect(one.body).toBe("Its terminal will close and whatever runs in it stops.")
    const oneClaude = closeConfirmText({
      kind: "tab",
      tabId: "t",
      title: "x",
      count: 1,
      agents: ["claude"],
    })
    expect(oneClaude.body).toBe(
      "Claude is running in its terminal. Closing it stops Claude and the shell.",
    )
    const term = closeConfirmText({
      kind: "terminal",
      tabId: "t",
      sessionId: "a",
      title: "zsh",
      agent: "claude",
    })
    expect(term.body).toMatch(/Claude is running/)
    const pane = closeConfirmText({ kind: "pane", tabId: "t", paneId: "p", count: 2 })
    expect(pane.title).toBe("Close pane with 2 terminals?")
  })
  it("names the agent that runs, or says agents when they differ", () => {
    const tab = (agents: ("claude" | "codex" | "opencode")[]) =>
      closeConfirmText({ kind: "tab", tabId: "t", title: "x", count: 3, agents }).body
    expect(tab(["codex", "codex"])).toMatch(/2 are running Codex\.$/)
    expect(tab(["claude", "codex"])).toMatch(/2 are running agents\.$/)
    const term = closeConfirmText({
      kind: "terminal",
      tabId: "t",
      sessionId: "a",
      title: "zsh",
      agent: "opencode",
    })
    expect(term.body).toBe(
      "OpenCode is running in this terminal. Closing it stops OpenCode and the shell.",
    )
  })
})

describe("confirmStillValid", () => {
  const leaf = (id: string, entryIds: string[]) => ({
    type: "leaf" as const,
    id,
    entryIds,
    activeEntryId: entryIds[0]!,
  })
  const tabs = [{ id: "t", root: leaf("p", ["a", "b"]) }]
  it("valid while the target is there; not once it's gone or moved to another tab", () => {
    expect(
      confirmStillValid(
        { kind: "terminal", tabId: "t", sessionId: "a", title: "", agent: undefined },
        tabs,
      ),
    ).toBe(true)
    expect(
      confirmStillValid(
        { kind: "terminal", tabId: "t", sessionId: "z", title: "", agent: undefined },
        tabs,
      ),
    ).toBe(false)
    expect(confirmStillValid({ kind: "pane", tabId: "t", paneId: "p", count: 2 }, tabs)).toBe(true)
    expect(confirmStillValid({ kind: "pane", tabId: "t", paneId: "q", count: 2 }, tabs)).toBe(false)
    expect(
      confirmStillValid({ kind: "tab", tabId: "x", title: "", count: 2, agents: [] }, tabs),
    ).toBe(false)
  })
})

describe("closeConfirmText: a pane's only terminal beside folders", () => {
  it("says the folder tabs go too, and the button closes the pane", () => {
    const t = closeConfirmText({
      kind: "terminal",
      tabId: "t",
      sessionId: "a",
      title: "x",
      paneId: "p",
    })
    expect(t.body).toMatch(/folder tabs close with it/)
    expect(t.action).toBe("Close pane")
  })
})

describe("unsaved files", () => {
  const leaf = (id: string, entryIds: string[]) => ({
    type: "leaf" as const,
    id,
    entryIds,
    activeEntryId: entryIds[0]!,
  })
  it("a pane or session with unsaved files asks; none, no question", () => {
    expect(unsavedCloseConfirm("t", [], 2, "p")).toBeNull()
    expect(unsavedCloseConfirm("t", ["a.ts"], 0, "p")).toEqual({
      kind: "unsaved",
      tabId: "t",
      files: ["a.ts"],
      terminals: 0,
      paneId: "p",
    })
  })
  it("says which files, and that terminals close too", () => {
    const one = closeConfirmText({ kind: "unsaved", tabId: "t", files: ["a.ts"], terminals: 0 })
    expect(one.title).toBe("Close a file with unsaved changes?")
    expect(one.body).toBe('"a.ts" has unsaved changes: closing drops them.')
    const many = closeConfirmText({
      kind: "unsaved",
      tabId: "t",
      files: ["a", "b", "c", "d"],
      terminals: 2,
    })
    expect(many.title).toBe("Close 4 files with unsaved changes?")
    expect(many.body).toContain('"a", "b" and 2 more have unsaved changes')
    expect(many.body).toContain("2 terminals close too")
  })
  it("a file's own close: save it, or don't", () => {
    const t = closeConfirmText({ kind: "file", tabId: "t", entryId: "e", title: "a.ts" })
    expect(t).toEqual({
      title: 'Save changes to "a.ts"?',
      body: "Your changes are lost if you don't save them.",
      action: "Don't save",
    })
  })
  it("stays valid while its file or pane is there", () => {
    const tabs = [{ id: "t", root: leaf("p", ["e"]) }]
    expect(confirmStillValid({ kind: "file", tabId: "t", entryId: "e", title: "" }, tabs)).toBe(
      true,
    )
    expect(confirmStillValid({ kind: "file", tabId: "t", entryId: "x", title: "" }, tabs)).toBe(
      false,
    )
    const u = { kind: "unsaved" as const, tabId: "t", files: ["a"], terminals: 0 }
    expect(confirmStillValid({ ...u, paneId: "p" }, tabs)).toBe(true)
    expect(confirmStillValid({ ...u, paneId: "q" }, tabs)).toBe(false)
    expect(confirmStillValid(u, tabs)).toBe(true)
  })
})
