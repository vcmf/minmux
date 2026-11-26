import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { FleetView } from "./fleet-view"
import { useStore } from "../store"
import { ipc } from "../lib/ipc"
import { reduceAgentEvents } from "../lib/agent-graph"
import { resetStore, testShell } from "../test/helpers"
import type { PrRow } from "../lib/pr-dashboard"

const row = (n: number): PrRow =>
  ({
    number: n,
    title: `PR ${n}`,
    url: `https://github.com/o/r/pull/${n}`,
    repo: "o/r",
    defaultBranch: "main",
    state: "open",
  }) as PrRow

// One pane `p1` in /w/r with a Claude session working there.
function seed() {
  useStore.setState({
    sessions: {
      p1: {
        id: "p1",
        title: "zsh",
        command: testShell.command,
        args: [],
        cwd: "/w/r",
        status: "idle",
        unread: false,
      },
    },
    agents: reduceAgentEvents([
      { event: "SessionStart", sessionId: "s1", cwd: "/w/r", paneId: "p1" },
      { event: "UserPromptSubmit", sessionId: "s1" },
    ]),
    paneGit: {
      p1: {
        root: "/w/r",
        forCwd: "/w/r",
        branch: "feat",
        pr: { number: 7, state: "open", url: "https://github.com/o/r/pull/7" },
      },
    },
  })
}

describe("FleetView", () => {
  let local: ReturnType<typeof vi.spyOn>
  beforeEach(() => {
    resetStore()
    local = vi.spyOn(ipc, "prLocal").mockResolvedValue({
      ok: true,
      repos: [
        {
          repo: "o/r",
          defaultBranch: "main",
          worktrees: [{ path: "/w/r", branch: "feat" }],
          roots: ["/w/r"],
        },
      ],
    })
    vi.spyOn(ipc, "prLists").mockResolvedValue({
      ok: true,
      lists: { mine: [row(7), row(8)], review: [] },
    })
  })
  afterEach(() => vi.restoreAllMocks())

  it("shows a repo's circle; opening it shows its PRs and agents; an agent leads to its pane", async () => {
    seed()
    render(<FleetView />)
    const root = await screen.findByRole("button", { name: "Open o/r" })
    await waitFor(() => expect(screen.getAllByText("2 PRs · 1 agent").length).toBeGreaterThan(0))
    fireEvent.click(root)
    expect((await screen.findAllByText("PR 7")).length).toBe(2) // its card and the panel
    expect(screen.getAllByText("PR 8").length).toBe(2) // mine, nobody on it
    const agent = screen.getByRole("button", { name: /^Claude agent .*working$/ })
    fireEvent.click(agent)
    const focus = vi.spyOn(useStore.getState(), "focusSession")
    fireEvent.click(screen.getByText("Go to pane"))
    expect(focus).toHaveBeenCalledWith("p1")
  })

  it("says so when no agent works in a repo", async () => {
    render(<FleetView />)
    expect(await screen.findByText("No agent is working in a repo right now.")).toBeInTheDocument()
  })

  it("re-reads the repos when a pane moves to another checkout, and when the window shows", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    seed()
    const view = render(<FleetView />)
    await waitFor(() => expect(local).toHaveBeenCalled())
    const before = local.mock.calls.length
    act(() => useStore.setState({ paneGit: { p1: { root: "/w/r2", branch: "main" } } }))
    await act(async () => void (await vi.advanceTimersByTimeAsync(700)))
    expect(local.mock.calls.length).toBeGreaterThan(before)
    expect(local.mock.calls.at(-1)![0].roots).toEqual(["/w/r2"])
    // The window shows again: whatever came due runs (nothing breaks when nothing did).
    act(() => void document.dispatchEvent(new Event("visibilitychange")))
    view.unmount()
    vi.useRealTimers()
  })

  it("a repo that leaves the model while open closes, and doesn't reopen by itself", async () => {
    seed()
    render(<FleetView />)
    fireEvent.click(await screen.findByRole("button", { name: "Open o/r" }))
    await screen.findAllByText("PR 7")
    const agents = useStore.getState().agents
    act(() => useStore.setState({ agents: reduceAgentEvents([]) })) // its session ended
    await waitFor(() => expect(screen.queryByText("PR 7")).toBeNull(), { timeout: 3000 })
    act(() => useStore.setState({ agents })) // an agent there again
    expect(
      await screen.findByRole("button", { name: "Open o/r" }, { timeout: 3000 }),
    ).toBeInTheDocument()
    expect(screen.queryByText("PR 7")).toBeNull() // still the overview
  })

  it("an open repo stays open when its key moves from its folder to owner/name", async () => {
    local.mockResolvedValueOnce({ ok: true, repos: [] }) // first: no GitHub name yet
    seed()
    render(<FleetView />)
    fireEvent.click(await screen.findByRole("button", { name: "Open r" }))
    await screen.findByRole("button", { name: /^Claude agent/ }) // opened, under its folder's key
    act(() => useStore.setState({ paneGit: { ...useStore.getState().paneGit } })) // roots refresh
    await waitFor(() => expect(screen.getAllByText("PR 7").length).toBeGreaterThan(0), {
      timeout: 3000,
    })
    expect(screen.queryByRole("button", { name: "Open o/r" })).toBeNull() // not the overview
  })
})
