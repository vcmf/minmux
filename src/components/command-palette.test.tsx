import { describe, it, expect, beforeEach, vi } from "vitest"
import { act, render, screen, fireEvent } from "@testing-library/react"
import { CommandPalette } from "./command-palette"
import { useStore } from "../store"
import { allSessionIds } from "../lib/pane-tree"
import { resetStore, testHost, testShell } from "../test/helpers"
import { ipc } from "../lib/ipc"

const st = () => useStore.getState()

beforeEach(() => {
  resetStore()
  vi.clearAllMocks()
})

describe("CommandPalette", () => {
  it("renders grouped commands", () => {
    st().newTab(testShell)
    render(<CommandPalette />)
    expect(screen.getByText("Session")).toBeInTheDocument()
    expect(screen.getByText("Appearance", { selector: ".palette-group" })).toBeInTheDocument()
    expect(screen.getAllByText("New session").length).toBeGreaterThan(0)
    expect(screen.getByText("Split pane right")).toBeInTheDocument()
  })

  it("filters by query", () => {
    st().newTab(testShell)
    render(<CommandPalette />)
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "theme" } })
    expect(screen.queryByText("Split pane right")).not.toBeInTheDocument()
    expect(screen.getAllByText("Theme").length).toBeGreaterThan(0)
  })

  it("Enter runs the selected command (new session adds a tab)", () => {
    render(<CommandPalette />)
    const before = st().tabs.length
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" })
    expect(st().tabs.length).toBe(before + 1)
  })

  it("arrow-down + Enter runs a split", () => {
    st().newTab(testShell)
    render(<CommandPalette />)
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "split pane right" } })
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" })
    expect(allSessionIds(st().tabs[0]!.root)).toHaveLength(2)
  })

  it("Escape closes the palette", () => {
    st().setPaletteOpen(true)
    render(<CommandPalette />)
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Escape" })
    expect(st().paletteOpen).toBe(false)
  })

  it("shows an empty state when nothing matches", () => {
    render(<CommandPalette />)
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "zzznope" } })
    expect(screen.getByText(/No matching commands/i)).toBeInTheDocument()
  })

  it("offers appearance switches and applies one", () => {
    render(<CommandPalette />)
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "appearance light" } })
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" })
    expect(st().settings.appearance).toBe("light")
  })
})

describe("CommandPalette — SSH", () => {
  it("connects to a host found by name", () => {
    st().setSshHosts([testHost("web", "native", "me@10.0.0.1"), testHost("db")])
    render(<CommandPalette />)
    // Matches on the host detail too (the sub line).
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "10.0.0.1" } })
    expect(document.querySelector(".palette-item.selected")!.textContent).toContain("web")
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" })
    expect(st().tabs).toHaveLength(1)
    expect(st().sessions[st().tabs[0]!.activeSessionId]!.remote?.hostId).toBe("native:web")
  })

  it("lists each host once, by name (no duplicate split rows), and never a hidden one", () => {
    st().setSshHosts([testHost("web"), { ...testHost("github.com"), hidden: true }])
    render(<CommandPalette />)
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "ssh" } })
    const rows = [...document.querySelectorAll(".palette-item")].map((r) => r.textContent ?? "")
    expect(rows.filter((t) => t.includes("web"))).toHaveLength(1)
    expect(rows.some((t) => t.includes("github.com"))).toBe(false)
    expect(rows.some((t) => /split right/i.test(t))).toBe(false)
  })

  it("Connect to host… opens the host picker", () => {
    st().setSshHosts([testHost("web")])
    render(<CommandPalette />)
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "connect to host" } })
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" })
    expect(st().hostPickerOpen).toBe(true)
  })

  it("opens the ssh config, even with no hosts", () => {
    render(<CommandPalette />)
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "ssh config" } })
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" })
    expect(ipc.openSshConfig).toHaveBeenCalled()
  })
})

describe("CommandPalette — a host list that changes while it's open", () => {
  it("Enter still runs the highlighted host after a host sorts in above it", () => {
    st().setSshHosts([testHost("alpha"), testHost("prod")])
    render(<CommandPalette />)
    const input = screen.getByRole("textbox")
    fireEvent.change(input, { target: { value: "ssh" } }) // Connect to host…, alpha, prod, …
    fireEvent.keyDown(input, { key: "ArrowDown" })
    fireEvent.keyDown(input, { key: "ArrowDown" }) // → prod
    expect(document.querySelector(".palette-item.selected")!.textContent).toContain("prod")
    act(() => st().setSshHosts([testHost("alpha"), testHost("beta"), testHost("prod")]))
    expect(document.querySelector(".palette-item.selected")!.textContent).toContain("prod")
    fireEvent.keyDown(input, { key: "Enter" })
    expect(st().sessions[st().tabs[0]!.activeSessionId]!.remote?.hostId).toBe("native:prod")
  })

  it("falls back to the first row (shown highlighted) when the selected host is gone", () => {
    st().setSshHosts([testHost("alpha"), testHost("prod")])
    render(<CommandPalette />)
    const input = screen.getByRole("textbox")
    fireEvent.change(input, { target: { value: "ssh" } })
    fireEvent.keyDown(input, { key: "ArrowDown" })
    fireEvent.keyDown(input, { key: "ArrowDown" }) // → prod
    act(() => st().setSshHosts([testHost("alpha")]))
    // prod is gone: the first row is highlighted, and Enter runs exactly that one.
    expect(document.querySelector(".palette-item.selected")!.textContent).toContain(
      "Connect to host",
    )
    fireEvent.keyDown(input, { key: "Enter" })
    expect(st().tabs).toHaveLength(0)
    expect(st().hostPickerOpen).toBe(true)
  })

  it("two commands that read the same keep separate selections", () => {
    st().newTab(testShell)
    st().newTab(testShell)
    st().newTab(testShell) // two other tabs, both titled the same
    render(<CommandPalette />)
    const input = screen.getByRole("textbox")
    fireEvent.change(input, { target: { value: "switch session" } })
    fireEvent.keyDown(input, { key: "ArrowDown" })
    const items = [...document.querySelectorAll(".palette-item")]
    expect(items[1]!.className).toContain("selected")
    expect(items[0]!.className).not.toContain("selected")
  })
})

describe("CommandPalette — selection follows identity, not text", () => {
  it("a host whose detail changes stays selected", () => {
    st().setSshHosts([testHost("alpha"), testHost("web", "native", "me@10.0.0.1")])
    render(<CommandPalette />)
    const input = screen.getByRole("textbox")
    fireEvent.change(input, { target: { value: "ssh" } })
    fireEvent.keyDown(input, { key: "ArrowDown" })
    fireEvent.keyDown(input, { key: "ArrowDown" }) // → web
    act(() => st().setSshHosts([testHost("alpha"), testHost("web", "native", "me@10.9.9.9")]))
    fireEvent.keyDown(input, { key: "Enter" })
    expect(st().sessions[st().tabs[0]!.activeSessionId]!.remote?.hostId).toBe("native:web")
  })

  it("the highlighted tab stays highlighted when an earlier same-titled tab closes", () => {
    st().newTab(testShell)
    st().newTab(testShell)
    st().newTab(testShell)
    st().newTab(testShell) // active; the other three are "Switch session" rows, all untitled
    const [t1, t2, t3] = st().tabs.map((t) => t.id)
    render(<CommandPalette />)
    const input = screen.getByRole("textbox")
    fireEvent.change(input, { target: { value: "switch session" } })
    fireEvent.keyDown(input, { key: "ArrowDown" }) // → t2
    act(() => st().closeTab(t1!))
    fireEvent.keyDown(input, { key: "Enter" })
    expect(st().activeTabId).toBe(t2)
    expect(t3).toBeDefined()
  })
})
