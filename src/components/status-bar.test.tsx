import { describe, it, expect, beforeEach, vi } from "vitest"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { StatusBar } from "./status-bar"
import { useStore } from "../store"
import { allSessionIds } from "../lib/pane-tree"
import { ipc } from "../lib/ipc"
import { resetStore, testHost, testShell } from "../test/helpers"
import { hostShellOption } from "../lib/ssh-hosts-ui"

const st = () => useStore.getState()

beforeEach(() => {
  resetStore()
  vi.clearAllMocks()
  vi.mocked(ipc.appVersion).mockResolvedValue("0.1.24")
})

describe("StatusBar", () => {
  it("shows the platform label (from ipc) and UTF-8", async () => {
    render(<StatusBar />)
    expect(await screen.findByText("macOS")).toBeInTheDocument()
    expect(screen.getByText("UTF-8")).toBeInTheDocument()
  })

  it("counts running and waiting sessions", () => {
    st().newTab(testShell)
    const id = allSessionIds(st().tabs[0]!.root)[0]!
    st().signalSession(id, { type: "command-start" }) // → working
    const { container } = render(<StatusBar />)
    expect(container.textContent).toContain("1 running")
    expect(container.textContent).toContain("0 waiting")
  })

  it("shows the git branch when in a repo", () => {
    st().setGit({
      isRepo: true,
      root: "",
      branch: "main",
      ahead: 0,
      behind: 0,
      files: [],
      add: 0,
      del: 0,
    })
    render(<StatusBar />)
    expect(screen.getByText("main")).toBeInTheDocument()
  })

  it("hides the branch when not a repo", () => {
    st().setGit({
      isRepo: false,
      root: "",
      branch: "",
      ahead: 0,
      behind: 0,
      files: [],
      add: 0,
      del: 0,
    })
    const { container } = render(<StatusBar />)
    expect(container.querySelectorAll(".status-item").length).toBeGreaterThan(0)
    expect(container.textContent).not.toContain("main")
  })
})

const upToDate = { current: "0.1.24", latest: "0.1.24", updateAvailable: false, url: "" }
const hasUpdate = {
  current: "0.1.24",
  latest: "0.1.25",
  updateAvailable: true,
  url: "https://github.com/vcmf/smterm/releases/latest",
}
const failed = { current: "0.1.24", latest: null, updateAvailable: false, url: "" }

describe("StatusBar version badge", () => {
  it("shows the app version, dim, when up to date", async () => {
    vi.mocked(ipc.checkUpdate).mockResolvedValue(upToDate)
    const { container } = render(<StatusBar />)
    expect(await screen.findByText("smterm 0.1.24")).toBeInTheDocument()
    expect(container.querySelector(".sb-version.update")).toBeNull() // no ping
  })

  it("pings and links to the release when an update is available", async () => {
    vi.mocked(ipc.checkUpdate).mockResolvedValue(hasUpdate)
    render(<StatusBar />)
    const badge = await screen.findByRole("button", { name: /v0\.1\.25/ })
    expect(badge).toHaveAttribute("title", expect.stringContaining("Update available — v0.1.25"))
    expect(badge.querySelector(".dot.pulse")).not.toBeNull() // the animated ping
    fireEvent.click(badge)
    expect(ipc.openExternal).toHaveBeenCalledWith("https://github.com/vcmf/smterm/releases/latest")
  })

  it("stays silent if the check fails (latest null)", async () => {
    vi.mocked(ipc.checkUpdate).mockResolvedValue(failed)
    const { container } = render(<StatusBar />)
    await waitFor(() => expect(screen.getByText("smterm 0.1.24")).toBeInTheDocument())
    expect(container.querySelector(".sb-version.update")).toBeNull()
  })

  // The "a failed re-check must not clear an existing ping" invariant is covered purely by
  // applyUpdateResult in version.test.ts (avoids flaky fake-timers + findBy interplay).
})

describe("StatusBar — ssh prompts count as waiting", () => {
  it("an ssh pane at a password prompt counts, like the bell", () => {
    st().newTab(hostShellOption(testHost("web")))
    st().setRemotePhase(st().tabs[0]!.activeSessionId, "prompt", "password")
    render(<StatusBar />)
    expect(screen.getByText(/1 waiting/)).toBeInTheDocument()
  })
})
