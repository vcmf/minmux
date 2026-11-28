import { beforeEach, describe, expect, it, vi } from "vitest"
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { RemoteSettings } from "./remote-settings"
import { StatusBar } from "./status-bar"
import { useStore } from "../store"
import { ipc } from "../lib/ipc"
import type { RemoteView } from "../lib/remote-view"
import { resetStore } from "../test/helpers"

const view = (over: Partial<RemoteView> = {}): RemoteView => ({
  status: { state: "listening", url: "http://mac:7420", machine: "mac", addresses: ["100.1.2.3"] },
  clients: [],
  enabled: true,
  port: 7420,
  devices: [],
  hasPin: false,
  pinUnlockOff: false,
  newerFile: false,
  ...over,
})

const enable = () =>
  useStore.setState((s) => ({ settings: { ...s.settings, remote: { enabled: true, port: 0 } } }))

beforeEach(() => {
  resetStore()
  vi.clearAllMocks()
})

describe("RemoteSettings", () => {
  it("turns remote control on through settings", () => {
    render(<RemoteSettings />)
    fireEvent.click(screen.getByRole("checkbox", { name: /Allow my devices/ }))
    expect(useStore.getState().settings.remote.enabled).toBe(true)
    expect(ipc.writeSettings).toHaveBeenCalled()
  })

  it("shows the address, a QR code, the PIN state and devices", async () => {
    enable()
    vi.mocked(ipc.remoteView).mockResolvedValue(
      view({
        hasPin: true,
        clients: [{ deviceId: "d1", name: "iphone-15" }],
        devices: [
          {
            id: "d1",
            name: "iphone-15",
            permission: "send",
            addedAt: 0,
            lastSeen: Date.now(),
            locked: false,
          },
          { id: "d2", name: "pixel", permission: "view", addedAt: 0, lastSeen: 0, locked: true },
        ],
      }),
    )
    render(<RemoteSettings />)
    await screen.findByText("http://mac:7420")
    fireEvent.click(screen.getByText("QR code"))
    expect(screen.getByAltText(/QR code for http:\/\/mac:7420/)).toBeInTheDocument()
    expect(screen.getByText("(set)")).toBeInTheDocument()
    expect(screen.getByText("connected")).toBeInTheDocument()
    expect(screen.getByText("locked")).toBeInTheDocument()

    fireEvent.change(screen.getAllByRole("combobox")[1]!, { target: { value: "keys" } })
    expect(ipc.remotePermission).toHaveBeenCalledWith("d2", "keys")
    fireEvent.click(screen.getAllByText("Remove")[0]!)
    expect(ipc.remoteRevoke).toHaveBeenCalledWith("d1")
    fireEvent.click(screen.getByText("Disconnect all"))
    expect(ipc.remoteDisconnectAll).toHaveBeenCalled()
  })

  it("sets a PIN and explains a refused one", async () => {
    enable()
    vi.mocked(ipc.remoteView).mockResolvedValue(view())
    render(<RemoteSettings />)
    const input = await screen.findByPlaceholderText("6+ digits")
    fireEvent.change(input, { target: { value: "12ab3456" } })
    expect((input as HTMLInputElement).value).toBe("123456")
    vi.mocked(ipc.remoteSetPin).mockResolvedValueOnce("ok")
    fireEvent.click(screen.getByText("Set"))
    await screen.findByText("PIN saved.")
    fireEvent.change(input, { target: { value: "654321" } })
    vi.mocked(ipc.remoteSetPin).mockResolvedValueOnce("readonly")
    fireEvent.keyDown(input, { key: "Enter" })
    await screen.findByText(/newer minmux/)
  })

  it.each([
    ["missing", /isn't installed/],
    ["signed-out", /signed out/],
    ["stopped", /isn't connected/],
    ["tagged", /tagged device/],
    ["port", /Port 7420 is already in use/],
    ["error", /retries every 30 seconds/],
  ] as const)("explains %s", async (reason, text) => {
    enable()
    vi.mocked(ipc.remoteView).mockResolvedValue(view({ status: { state: "error", reason } }))
    render(<RemoteSettings />)
    await screen.findByText(text)
  })

  it("says when a newer build owns the device list", async () => {
    enable()
    vi.mocked(ipc.remoteView).mockResolvedValue(view({ newerFile: true, pinUnlockOff: true }))
    render(<RemoteSettings />)
    await screen.findByText(/A newer minmux saved the device list/)
    expect(screen.getByText(/off after too many wrong PINs/)).toBeInTheDocument()
  })
})

describe("status bar: connected devices", () => {
  it("names a connected device and opens Settings on click", async () => {
    enable()
    vi.mocked(ipc.remoteView).mockResolvedValue(
      view({ clients: [{ deviceId: "d1", name: "iphone-15" }] }),
    )
    render(<StatusBar />)
    const item = await screen.findByText("iphone-15 connected")
    fireEvent.click(item)
    expect(useStore.getState().settingsOpen).toBe(true)
  })

  it("counts several and shows nothing when off", async () => {
    enable()
    vi.mocked(ipc.remoteView).mockResolvedValue(
      view({
        clients: [
          { deviceId: "a", name: "a" },
          { deviceId: "b", name: "b" },
        ],
      }),
    )
    const { unmount } = render(<StatusBar />)
    await screen.findByText("2 devices connected")
    unmount()
    act(() =>
      useStore.setState((s) => ({
        settings: { ...s.settings, remote: { enabled: false, port: 0 } },
      })),
    )
    render(<StatusBar />)
    await waitFor(() => expect(screen.queryByText(/connected$/)).toBeNull())
  })
})
