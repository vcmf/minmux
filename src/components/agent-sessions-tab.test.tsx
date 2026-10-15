import { describe, it, expect, beforeEach, vi } from "vitest"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { AgentSessionsTab } from "./agent-sessions-tab"
import { AgentsPanel } from "./agents-panel"
import { useStore } from "../store"
import { ipc } from "../lib/ipc"
import { reduceAgentEvents } from "../lib/agent-graph"
import type { PastSession } from "../lib/past-sessions"
import type { ResumePlan } from "../lib/resume"
import { resetStore, testShell } from "../test/helpers"

const LIVE = "11111111-aaaa-bbbb-cccc-dddddddddddd"
const PAST = "22222222-aaaa-bbbb-cccc-dddddddddddd"
const GONE = "33333333-aaaa-bbbb-cccc-dddddddddddd"
const rows: PastSession[] = [
  { agent: "claude", sessionId: LIVE, name: "running one", cwd: "/w/term", updatedAt: Date.now() },
  {
    agent: "codex",
    sessionId: PAST,
    firstPrompt: "fix the quit drain",
    cwd: "/w/other",
    updatedAt: 1,
  },
  { agent: "claude", sessionId: GONE, name: "old", cwd: "/w/gone", updatedAt: 0, cwdGone: true },
]

describe("AgentSessionsTab", () => {
  beforeEach(() => {
    resetStore()
    localStorage.clear()
    vi.clearAllMocks()
    useStore.getState().newTab(testShell)
    const term = useStore.getState().tabs[0]!.activeSessionId
    useStore.setState({
      platform: "darwin",
      agents: reduceAgentEvents([
        { event: "SessionStart", sessionId: LIVE, paneId: term, cwd: "/w/term" },
      ]),
    })
    vi.mocked(ipc.pastSessions).mockResolvedValue({ sessions: rows, failed: [] })
  })

  it("lists past sessions by name or first prompt, with their folder", async () => {
    render(<AgentSessionsTab />)
    expect(await screen.findByText("running one")).toBeInTheDocument()
    expect(screen.getByText("fix the quit drain")).toBeInTheDocument()
    expect(screen.getByText("/w/other")).toBeInTheDocument()
    expect(screen.getByText(/folder gone/)).toBeInTheDocument()
  })

  it("a running session: click goes to its pane, nothing is resumed", async () => {
    const focus = vi.fn()
    useStore.setState({ focusSession: focus })
    render(<AgentSessionsTab />)
    fireEvent.click(await screen.findByText("running one"))
    expect(focus).toHaveBeenCalledWith(useStore.getState().tabs[0]!.activeSessionId)
    expect(ipc.resumeOne).not.toHaveBeenCalled()
  })

  it("another session: asks main for its plan and resumes it in a split", async () => {
    const plan: ResumePlan = {
      status: "resume",
      agent: "codex",
      sessionId: PAST,
      cwd: "/w/other",
      command: `codex resume ${PAST}`,
    }
    vi.mocked(ipc.resumeOne).mockResolvedValue(plan)
    const resumeInSplit = vi.fn(() => "new-term")
    useStore.setState({ resumeInSplit })
    render(<AgentSessionsTab />)
    fireEvent.click(await screen.findByText("fix the quit drain"))
    await waitFor(() => expect(resumeInSplit).toHaveBeenCalledWith(plan))
    expect(ipc.resumeOne).toHaveBeenCalledWith({ agent: "codex", sessionId: PAST }, false)
  })

  it("says why when main won't resume it", async () => {
    vi.mocked(ipc.resumeOne).mockResolvedValue({
      status: "skip",
      sessionId: PAST,
      cwd: "/w/other",
      reason: "unrecognised session id",
    })
    render(<AgentSessionsTab />)
    fireEvent.click(await screen.findByText("fix the quit drain"))
    expect(await screen.findByText(/unrecognised session id/)).toBeInTheDocument()
  })

  it("a session whose folder is gone does nothing", async () => {
    render(<AgentSessionsTab />)
    fireEvent.click(await screen.findByText("old"))
    expect(ipc.resumeOne).not.toHaveBeenCalled()
  })

  it("an agent's chip hides its sessions, and stays off", async () => {
    const { unmount } = render(<AgentSessionsTab />)
    await screen.findByText("fix the quit drain")
    fireEvent.click(screen.getByTitle("Hide Codex sessions"))
    expect(screen.queryByText("fix the quit drain")).toBeNull()
    unmount()
    render(<AgentSessionsTab />)
    await screen.findByText("running one")
    expect(screen.queryByText("fix the quit drain")).toBeNull()
  })

  it("main says it may be running elsewhere: a second click resumes it anyway", async () => {
    const plan: ResumePlan = {
      status: "resume",
      agent: "codex",
      sessionId: PAST,
      cwd: "/w/other",
      command: `codex resume ${PAST}`,
    }
    vi.mocked(ipc.resumeOne).mockImplementation(async (_s, confirmed) =>
      confirmed
        ? plan
        : {
            ...plan,
            status: "skip",
            busy: true,
            reason: "written 5s ago, may be running elsewhere",
          },
    )
    const resumeInSplit = vi.fn(() => "new-term")
    useStore.setState({ resumeInSplit })
    render(<AgentSessionsTab />)
    fireEvent.click(await screen.findByText("fix the quit drain"))
    expect(await screen.findByText(/may be running elsewhere: click again/)).toBeInTheDocument()
    expect(resumeInSplit).not.toHaveBeenCalled()
    fireEvent.click(screen.getByText("fix the quit drain"))
    await waitFor(() => expect(resumeInSplit).toHaveBeenCalledWith(plan))
    expect(vi.mocked(ipc.resumeOne).mock.calls.map((c) => c[1])).toEqual([false, true])
  })

  it("every agent hidden: says so, not that there are none", async () => {
    localStorage.setItem("minmux.sessions.hidden", JSON.stringify(["claude", "codex"]))
    render(<AgentSessionsTab />)
    expect(await screen.findByText("Every agent is hidden: turn one on above.")).toBeInTheDocument()
  })

  it("keys: Enter or Space on a row resumes it, Enter on its copy button doesn't", async () => {
    vi.mocked(ipc.resumeOne).mockResolvedValue(null)
    render(<AgentSessionsTab />)
    const row = (await screen.findByText("fix the quit drain")).closest(".past-session")!
    fireEvent.keyDown(row.querySelector(".past-session-id")!, { key: "Enter" })
    expect(ipc.resumeOne).not.toHaveBeenCalled()
    fireEvent.keyDown(row, { key: " " })
    await waitFor(() => expect(ipc.resumeOne).toHaveBeenCalledTimes(1))
  })

  it("says so when no terminal could be opened", async () => {
    vi.mocked(ipc.resumeOne).mockResolvedValue({
      status: "resume",
      sessionId: PAST,
      cwd: "/w/other",
      command: "codex resume x",
    })
    useStore.setState({ resumeInSplit: vi.fn(() => undefined) })
    render(<AgentSessionsTab />)
    fireEvent.click(await screen.findByText("fix the quit drain"))
    expect(await screen.findByText(/couldn't open a terminal/)).toBeInTheDocument()
  })

  it("names the agents whose sessions couldn't be read", async () => {
    vi.mocked(ipc.pastSessions).mockResolvedValue({ sessions: [], failed: ["codex"] })
    render(<AgentSessionsTab />)
    expect(await screen.findByText("Couldn't read Codex sessions.")).toBeInTheDocument()
  })
})

describe("AgentsPanel tabs", () => {
  beforeEach(() => {
    resetStore()
    localStorage.clear()
    vi.clearAllMocks()
  })

  it("opens on Live, switches to Sessions and remembers it", async () => {
    vi.mocked(ipc.pastSessions).mockResolvedValue({ sessions: [], failed: [] })
    const { unmount } = render(<AgentsPanel />)
    expect(ipc.pastSessions).not.toHaveBeenCalled() // nothing read until the tab is shown
    fireEvent.click(screen.getByRole("tab", { name: "Sessions" }))
    expect(await screen.findByText("No past sessions yet.")).toBeInTheDocument()
    unmount()
    render(<AgentsPanel />)
    expect(screen.getByRole("tab", { name: "Sessions" })).toHaveAttribute("aria-selected", "true")
  })
})
