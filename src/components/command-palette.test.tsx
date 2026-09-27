import { describe, it, expect, beforeEach, vi } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
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
