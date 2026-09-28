import { beforeEach, describe, expect, it, vi } from "vitest"
import { fireEvent, render, screen } from "@testing-library/react"
import { HostPicker } from "./host-picker"
import { useStore } from "../store"
import { ipc } from "../lib/ipc"
import { resetStore, testHost, testShell } from "../test/helpers"

vi.mock("../terminal/terminal-manager", () => ({
  TerminalManager: { attach: vi.fn(), fit: vi.fn(), focus: vi.fn(), dispose: vi.fn() },
}))

const st = () => useStore.getState()
const input = () => screen.getByRole("textbox", { name: "Connect to host" })
const labels = () =>
  [...document.querySelectorAll(".host-picker-row .host-picker-name")].map((e) => e.textContent)

beforeEach(() => {
  resetStore()
  vi.clearAllMocks()
  useStore.setState({ hostPickerOpen: true })
})

describe("HostPicker", () => {
  it("lists pinned, recent, then all hosts, host first; hidden ones only in the footer", () => {
    st().setSshHosts([
      testHost("alpha"),
      testHost("beta", "native", "me@10.0.0.2"),
      testHost("gpu"),
      { ...testHost("github.com"), hidden: true },
    ])
    useStore.setState((s) => ({
      settings: { ...s.settings, ssh: { ...s.settings.ssh, pinned: ["native:gpu"] } },
      sshRecent: ["native:beta"],
    }))
    render(<HostPicker />)
    expect(screen.getByText("Pinned")).toBeInTheDocument()
    expect(screen.getByText("Recent")).toBeInTheDocument()
    expect(labels()).toEqual(["gpu", "beta", "alpha"])
    expect(screen.getByText("me@10.0.0.2")).toBeInTheDocument()
    expect(screen.queryByText("github.com")).not.toBeInTheDocument()
    fireEvent.click(screen.getByText("Hidden (1)"))
    expect(screen.getByText("github.com")).toBeInTheDocument()
    fireEvent.click(screen.getByText("Show"))
    expect(st().settings.ssh.hidden).not.toContain("github.com")
  })

  it("filters as you type; Enter opens a new tab and closes the picker", () => {
    st().setSshHosts([testHost("alpha"), testHost("beta", "native", "me@10.0.0.2")])
    render(<HostPicker />)
    fireEvent.change(input(), { target: { value: "10.0.0.2" } })
    expect(labels()).toEqual(["beta"])
    fireEvent.keyDown(input(), { key: "Enter" })
    expect(st().hostPickerOpen).toBe(false)
    expect(st().sessions[st().tabs[0]!.activeSessionId]!.remote?.hostId).toBe("native:beta")
    expect(st().sshRecent).toEqual(["native:beta"])
  })

  it("⌥⏎ splits right, ⇧⏎ splits down, on the highlighted host", () => {
    st().setShells([testShell])
    st().newTab(testShell)
    st().setSshHosts([testHost("alpha"), testHost("beta")])
    const { unmount } = render(<HostPicker />)
    fireEvent.keyDown(input(), { key: "ArrowDown" }) // → beta
    fireEvent.keyDown(input(), { key: "Enter", altKey: true })
    const tab = st().tabs[0]!
    expect(tab.root.type === "split" && tab.root.direction).toBe("row")
    expect(st().sessions[tab.activeSessionId]!.remote?.hostId).toBe("native:beta")
    unmount()
    useStore.setState({ hostPickerOpen: true })
    render(<HostPicker />)
    fireEvent.keyDown(input(), { key: "Enter", shiftKey: true })
    expect(st().sessions[st().tabs[0]!.activeSessionId]!.remote).toBeDefined()
  })

  it("Esc closes; nothing opens", () => {
    st().setSshHosts([testHost("alpha")])
    render(<HostPicker />)
    fireEvent.keyDown(input(), { key: "Escape" })
    expect(st().hostPickerOpen).toBe(false)
    expect(st().tabs).toHaveLength(0)
  })

  it("right-click: pin a host, or copy its ssh command", () => {
    st().setSshHosts([testHost("alpha")])
    render(<HostPicker />)
    const row = document.querySelector(".host-picker-row")!
    fireEvent.contextMenu(row)
    fireEvent.mouseDown(screen.getByText("Pin to sidebar"))
    expect(st().settings.ssh.pinned).toEqual(["native:alpha"])
    // Pinned now: the row moved to the Pinned section (a new element).
    fireEvent.contextMenu(document.querySelector(".host-picker-row")!)
    fireEvent.mouseDown(screen.getByText("Copy ssh command"))
    expect(ipc.clipboardWrite).toHaveBeenCalledWith("ssh alpha")
    expect(st().hostPickerOpen).toBe(true) // the menu's own backdrop didn't close the picker
  })

  it("no hosts at all: says where they come from", () => {
    st().setSshHosts([])
    render(<HostPicker />)
    expect(screen.getByText(/No hosts yet/)).toBeInTheDocument()
    fireEvent.click(screen.getAllByText("Open ssh config")[0]!)
    expect(ipc.openSshConfig).toHaveBeenCalled()
  })
})

describe("HostPicker — focus", () => {
  it("after a right-click action, the filter has focus again", () => {
    st().setSshHosts([testHost("alpha")])
    render(<HostPicker />)
    fireEvent.contextMenu(document.querySelector(".host-picker-row")!)
    fireEvent.mouseDown(screen.getByText("Pin to sidebar"))
    expect(document.activeElement).toBe(input())
  })
})

describe("HostPicker — everything hidden", () => {
  it("says the hosts are hidden (not that there are none)", () => {
    st().setSshHosts([{ ...testHost("github.com"), hidden: true }])
    render(<HostPicker />)
    expect(screen.getByText(/All your hosts are hidden/)).toBeInTheDocument()
    expect(screen.queryByText(/No hosts yet/)).not.toBeInTheDocument()
  })
})
