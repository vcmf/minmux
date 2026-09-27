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
    expect(screen.getByText("Connect to host")).toBeInTheDocument()
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" })
    expect(st().tabs).toHaveLength(1)
    expect(st().sessions[st().tabs[0]!.activeSessionId]!.remote?.hostId).toBe("native:web")
  })

  it("splits right on a host", () => {
    st().newTab(testShell)
    st().setSshHosts([testHost("web")])
    render(<CommandPalette />)
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "split right on host" } })
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" })
    expect(allSessionIds(st().tabs[0]!.root)).toHaveLength(2)
    expect(st().sessions[st().tabs[0]!.activeSessionId]!.remote?.hostId).toBe("native:web")
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
    fireEvent.change(input, { target: { value: "connect to host" } })
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
    fireEvent.change(input, { target: { value: "connect to host" } })
    fireEvent.keyDown(input, { key: "ArrowDown" })
    act(() => st().setSshHosts([testHost("alpha")]))
    expect(document.querySelector(".palette-item.selected")!.textContent).toContain("alpha")
    fireEvent.keyDown(input, { key: "Enter" })
    expect(st().sessions[st().tabs[0]!.activeSessionId]!.remote?.hostId).toBe("native:alpha")
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
