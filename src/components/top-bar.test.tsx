import { describe, it, expect, beforeEach, vi } from "vitest"
import { act, render, screen, fireEvent } from "@testing-library/react"
import { TopBar } from "./top-bar"
import { useStore } from "../store"
import { ipc } from "../lib/ipc"
import { TerminalManager } from "../terminal/terminal-manager"
import { allSessionIds } from "../lib/pane-tree"
import { resetStore, testHost, testShell } from "../test/helpers"
import { hostShellOption } from "../lib/ssh-hosts-ui"

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
    expect(screen.getByText("minmux")).toBeInTheDocument()
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

describe("TopBar — profile badge", () => {
  it("shows a non-default profile next to the brand, nothing for the installed app", () => {
    const { unmount } = render(<TopBar />)
    expect(document.querySelector(".brand-profile")).toBeNull()
    unmount()
    useStore.setState({ profile: "dev" })
    render(<TopBar />)
    expect(document.querySelector(".brand-profile")!.textContent).toBe("dev")
  })
})

describe("TopBar — ssh states on the tab dot and the bell", () => {
  it("a disconnected ssh pane turns its tab's dot red; a prompt, amber, and counts on the bell", () => {
    st().newTab(hostShellOption(testHost("web")))
    const id = st().tabs[0]!.activeSessionId
    st().setRemotePhase(id, "closed", "lost")
    st().newTab(testShell) // another tab in front: the ssh pane is off-screen
    const { rerender } = render(<TopBar />)
    expect(document.querySelector(".tab .dot.red")).not.toBeNull()
    act(() => st().setRemotePhase(id, "prompt", "password"))
    rerender(<TopBar />)
    expect(document.querySelector(".tab .dot.amber")).not.toBeNull()
    expect(screen.getByText("1")).toBeInTheDocument() // bell count
  })

  it("a clean exit on the host isn't a red tab", () => {
    st().newTab(hostShellOption(testHost("web")))
    st().setRemotePhase(st().tabs[0]!.activeSessionId, "closed", "ended")
    render(<TopBar />)
    expect(document.querySelector(".tab .dot.red")).toBeNull()
  })

  it("a live ssh pane leaves the tab dot to the ordinary status", () => {
    st().newTab(hostShellOption(testHost("web")))
    st().setRemotePhase(st().tabs[0]!.activeSessionId, "live")
    render(<TopBar />)
    expect(document.querySelector(".tab .dot.red, .tab .dot.amber")).toBeNull()
  })
})

describe("TopBar — host colour on the tab", () => {
  it("a tab whose focused pane is on a coloured host is underlined in that colour", () => {
    useStore.setState((s) => ({
      settings: { ...s.settings, ssh: { ...s.settings.ssh, colors: { "prod-*": "red" } } },
    }))
    st().newTab(hostShellOption(testHost("prod-db")))
    st().newTab(testShell)
    render(<TopBar />)
    const tabs = [...document.querySelectorAll(".tab")] as HTMLElement[]
    expect(tabs[0]!.style.boxShadow).toContain("var(--red)")
    expect(tabs[1]!.style.boxShadow).toBe("")
  })
})

describe("TopBar — tabs spanning hosts", () => {
  it("shows the +N in its own span (it survives the title's ellipsis)", () => {
    st().newTab(hostShellOption(testHost("prod-db-replica-eu-west-1")))
    st().splitWith("row", hostShellOption(testHost("staging")))
    render(<TopBar />)
    expect(document.querySelector(".tab-title")!.textContent).toBe("staging")
    expect(document.querySelector(".tab-more")!.textContent).toBe("+1")
  })
})

describe("TopBar — renaming a tab that spans hosts", () => {
  it("pre-fills the name only, so a plain blur can't pin the live +N", () => {
    st().newTab(hostShellOption(testHost("gpu")))
    st().splitWith("row", testShell)
    render(<TopBar />)
    fireEvent.doubleClick(document.querySelector(".tab")!)
    const input = document.querySelector(".tab-rename") as HTMLInputElement
    expect(input.value).not.toContain("+1")
  })
})

describe("TopBar — renaming a tab", () => {
  const field = () => document.querySelector(".tab-rename") as HTMLInputElement | null

  it("double-click, type, Enter: saves the trimmed name and closes the field", () => {
    st().newTab(testShell)
    render(<TopBar />)
    fireEvent.doubleClick(document.querySelector(".tab")!)
    expect(document.activeElement).toBe(field())
    fireEvent.change(field()!, { target: { value: " build " } })
    fireEvent.keyDown(field()!, { key: "Enter" })
    expect(st().tabs[0]!.title).toBe("build")
    expect(field()).toBeNull()
    expect(document.querySelector(".tab-title")!.textContent).toBe("build")
  })

  it("Escape cancels, even with the blur the field's unmount fires", () => {
    st().newTab(testShell)
    render(<TopBar />)
    fireEvent.doubleClick(document.querySelector(".tab")!)
    const input = field()!
    fireEvent.change(input, { target: { value: "nope" } })
    act(() => {
      fireEvent.keyDown(input, { key: "Escape" })
      fireEvent.blur(input)
    })
    expect(st().tabs[0]!.title).toBe("")
  })

  it("an empty name keeps the old one", () => {
    st().newTab(testShell)
    st().renameTab(st().tabs[0]!.id, "keep")
    render(<TopBar />)
    fireEvent.doubleClick(document.querySelector(".tab")!)
    fireEvent.change(field()!, { target: { value: "" } })
    fireEvent.blur(field()!)
    expect(st().tabs[0]!.title).toBe("keep")
  })
})

describe("TopBar — the new-tab menu's hosts", () => {
  it("lists the first few (pinned, recent, then config order) and All hosts… for the rest", () => {
    st().setSshHosts([
      ...Array.from({ length: 9 }, (_, i) => testHost(`h${i}`)),
      { ...testHost("github.com"), hidden: true },
    ])
    useStore.setState({ sshRecent: ["native:h8"] })
    render(<TopBar />)
    fireEvent.click(screen.getByTitle("New tab in…"))
    const names = [...document.querySelectorAll(".shell-menu-host-name")].map((e) => e.textContent)
    expect(names).toEqual(["h8", "h0", "h1", "h2", "h3", "h4"])
    expect(screen.queryByText("github.com")).not.toBeInTheDocument()
    fireEvent.mouseDown(screen.getByText("All hosts (9)…"))
    expect(st().hostPickerOpen).toBe(true)
  })
})

describe("TopBar — Connect all", () => {
  it("shows with two or more waiting ssh panes, and connects them", () => {
    const spy = vi.spyOn(TerminalManager, "connectAll").mockImplementation(() => {})
    st().newTab(hostShellOption(testHost("a")))
    st().newTab(hostShellOption(testHost("b")))
    const [x, y] = st().tabs.map((t) => t.activeSessionId)
    st().setRemotePhase(x!, "waiting")
    const { rerender } = render(<TopBar />)
    expect(screen.queryByText(/Connect all/)).not.toBeInTheDocument() // one: its own button will do
    act(() => st().setRemotePhase(y!, "waiting"))
    rerender(<TopBar />)
    fireEvent.click(screen.getByText("Connect all (2)"))
    expect(spy).toHaveBeenCalled()
    spy.mockRestore()
  })
})
