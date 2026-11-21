import { describe, it, expect, beforeEach, vi } from "vitest"
import { act, render, screen } from "@testing-library/react"
import { TopBar } from "./top-bar"
import { ipc } from "../lib/ipc"
import { resetStore } from "../test/helpers"

vi.mock("../lib/platform", async (orig) => ({
  ...(await orig<typeof import("../lib/platform")>()),
  isMac: true,
}))

beforeEach(() => {
  resetStore()
  vi.clearAllMocks()
})

describe("TopBar on macOS", () => {
  it("draws no window controls: the system's own sit inset, with room left for them", () => {
    const { container } = render(<TopBar />)
    expect(screen.queryByTitle("Minimize")).toBeNull()
    expect(screen.queryByTitle("Close")).toBeNull()
    expect(container.querySelector(".topbar")).toHaveClass("mac-buttons")
  })

  it("full screen hides the system buttons, so the room goes too", () => {
    let push: (full: boolean) => void = () => {}
    vi.mocked(ipc.onFullScreenChange).mockImplementationOnce((cb) => {
      push = cb
      return () => {}
    })
    const { container } = render(<TopBar />)
    act(() => push(true))
    expect(container.querySelector(".topbar")).not.toHaveClass("mac-buttons")
    act(() => push(false))
    expect(container.querySelector(".topbar")).toHaveClass("mac-buttons")
  })
})
