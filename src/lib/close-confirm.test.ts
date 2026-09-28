import { describe, it, expect } from "vitest"
import { tabCloseConfirm, terminalCloseConfirm, closeConfirmText } from "./close-confirm"

const idle = (id: string) => ({ id, running: false, claude: false })

describe("tabCloseConfirm", () => {
  it("a single idle terminal closes right away", () => {
    expect(tabCloseConfirm("t", "term", [idle("a")])).toBeNull()
    expect(tabCloseConfirm("t", "term", [])).toBeNull()
  })
  it("more than one terminal always asks, running or not", () => {
    expect(tabCloseConfirm("t", "term", [idle("a"), idle("b")])).toMatchObject({
      kind: "tab",
      count: 2,
      claude: 0,
    })
  })
  it("a single terminal asks when it's running a command or Claude", () => {
    expect(tabCloseConfirm("t", "term", [{ id: "a", running: true, claude: false }])).not.toBeNull()
    expect(tabCloseConfirm("t", "term", [{ id: "a", running: false, claude: true }])).toMatchObject(
      {
        claude: 1,
      },
    )
  })
})

describe("terminalCloseConfirm", () => {
  it("asks only while the terminal is running", () => {
    expect(terminalCloseConfirm("t", "zsh", idle("a"))).toBeNull()
    expect(terminalCloseConfirm("t", "zsh", { id: "a", running: true, claude: false })).toEqual({
      kind: "terminal",
      tabId: "t",
      sessionId: "a",
      title: "zsh",
      claude: false,
    })
  })
})

describe("closeConfirmText", () => {
  it("says what will close and mentions Claude", () => {
    const tab = closeConfirmText({ kind: "tab", tabId: "t", title: "term", count: 3, claude: 1 })
    expect(tab.title).toBe('Close "term"?')
    expect(tab.body).toBe(
      "3 terminals will close and whatever runs in them stops. 1 is running Claude.",
    )
    expect(tab.action).toBe("Close session")
    const one = closeConfirmText({ kind: "tab", tabId: "t", title: "x", count: 1, claude: 0 })
    expect(one.body).toBe("Its terminal will close and whatever runs in it stops.")
    const term = closeConfirmText({
      kind: "terminal",
      tabId: "t",
      sessionId: "a",
      title: "zsh",
      claude: true,
    })
    expect(term.body).toMatch(/Claude is running/)
    const pane = closeConfirmText({ kind: "pane", tabId: "t", paneId: "p", count: 2 })
    expect(pane.title).toBe("Close pane with 2 terminals?")
  })
})
