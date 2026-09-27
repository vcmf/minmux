import { describe, it, expect, beforeEach, vi } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
import { TopBar } from "./top-bar"
import { useStore } from "../store"
import { ipc } from "../lib/ipc"
import { allSessionIds } from "../lib/pane-tree"
import { resetStore, testHost, testShell } from "../test/helpers"

const st = () => useStore.getState()

beforeEach(() => {
  resetStore()
  vi.clearAllMocks()
})

describe("TopBar", () => {
  it("renders the brand and open tabs", () => {
    st().newTab(testShell)
    st().renameTab(st().tabs[0]!.id, "build")
    render(<TopBar />)
    expect(screen.getByText("smterm")).toBeInTheDocument()
    expect(screen.getByText("build")).toBeInTheDocument()
  })

  it("the search pill opens the command palette", () => {
    render(<TopBar />)
    fireEvent.click(screen.getByText("Search or run"))
    expect(st().paletteOpen).toBe(true)
  })

  it("the + button opens a new tab", () => {
    render(<TopBar />)
    const before = st().tabs.length
    fireEvent.click(screen.getByTitle("New tab"))
    expect(st().tabs.length).toBe(before + 1)
  })

  it("window controls call the ipc seam", () => {
    render(<TopBar />)
    fireEvent.click(screen.getByTitle("Minimize"))
    fireEvent.click(screen.getByTitle("Maximize"))
    fireEvent.click(screen.getByTitle("Close"))
    expect(ipc.minimizeWindow).toHaveBeenCalledOnce()
    expect(ipc.maximizeWindow).toHaveBeenCalledOnce()
    expect(ipc.closeWindow).toHaveBeenCalledOnce()
  })

  it("the right-panel icons switch the shared view (click active → hide)", () => {
    render(<TopBar />)
    fireEvent.click(screen.getByTitle("Changes"))
    expect(st().rightView).toBe("changes")
    fireEvent.click(screen.getByTitle("Files")) // switch view, not stack
    expect(st().rightView).toBe("files")
    fireEvent.click(screen.getByTitle("Files")) // click active → hide
    expect(st().rightView).toBeNull()
  })

  it("the bell shows a waiting count and jumps to that session", () => {
    st().newTab(testShell)
    st().newTab(testShell)
    const waitingTab = st().tabs[0]!
    const waitingSession = allSessionIds(waitingTab.root)[0]!
    useStore.setState({ windowFocused: false })
    st().signalSession(waitingSession, { type: "attention" })
    useStore.setState({ activeTabId: st().tabs[1]!.id }) // focus the other tab
    render(<TopBar />)
    expect(screen.getByText("1")).toBeInTheDocument() // bell count
    fireEvent.click(screen.getByTitle(/waiting — jump/))
    expect(st().activeTabId).toBe(waitingTab.id)
  })

  it("the shell menu opens and spawns a chosen shell", () => {
    useStore.setState({
      shells: [testShell, { id: "bash", label: "bash", command: "/bin/bash", args: [] }],
    })
    const { container } = render(<TopBar />)
    fireEvent.click(screen.getByTitle("New tab in…"))
    expect(container.querySelector(".shell-menu")).toBeTruthy()
    const before = st().tabs.length
    fireEvent.mouseDown(screen.getByText("bash")) // menu item
    expect(st().tabs.length).toBe(before + 1)
    expect(container.querySelector(".shell-menu")).toBeFalsy() // menu closed
  })

  it("the sun/moon button flips the current theme between dark and light", () => {
    render(<TopBar />)
    fireEvent.click(screen.getByLabelText("Switch to light theme"))
    expect(st().settings.appearance).toBe("light")
    fireEvent.click(screen.getByLabelText("Switch to dark theme"))
    expect(st().settings.appearance).toBe("dark")
  })

  it("from System, it switches to the opposite of what the OS shows", () => {
    st().setSystemDark(false)
    st().setSettings({ ...st().settings, appearance: "system" })
    render(<TopBar />)
    fireEvent.click(screen.getByLabelText("Switch to dark theme"))
    expect(st().settings.appearance).toBe("dark")
  })
})

describe("TopBar — SSH hosts in the new-tab picker", () => {
  it("lists hosts after the shells and opens one in a new tab", () => {
    st().setSshHosts([testHost("web"), testHost("gpu", "wsl:Ubuntu")])
    render(<TopBar />)
    fireEvent.click(screen.getByTitle("New tab in…"))
    expect(screen.getByText("SSH")).toBeInTheDocument()
    expect(screen.getByText("WSL: Ubuntu")).toBeInTheDocument()
    fireEvent.mouseDown(screen.getByText("gpu"))
    expect(st().tabs).toHaveLength(1)
    expect(st().sessions[st().tabs[0]!.activeSessionId]!.remote?.hostId).toBe("wsl:Ubuntu:gpu")
    expect(screen.queryByText("SSH")).not.toBeInTheDocument() // the menu closed
  })

  it("has no SSH group without hosts", () => {
    render(<TopBar />)
    fireEvent.click(screen.getByTitle("New tab in…"))
    expect(screen.queryByText("SSH")).not.toBeInTheDocument()
  })
})

describe("TopBar — picker with hosts but no local shells", () => {
  it("the caret stays usable so the hosts can still be opened", () => {
    useStore.setState({ shells: [] })
    st().setSshHosts([testHost("web")])
    render(<TopBar />)
    expect(screen.getByTitle("New tab in…")).not.toBeDisabled()
  })
})
