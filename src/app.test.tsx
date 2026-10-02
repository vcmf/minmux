import { describe, it, expect, beforeEach, vi } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"
import App from "./app"
import { useStore } from "./store"
import { ipc } from "./lib/ipc"
import { resetStore, testHost, testShell } from "./test/helpers"
import { hostShellOption } from "./lib/ssh-hosts-ui"

vi.mock("./terminal/terminal-manager", () => ({
  TerminalManager: {
    attach: vi.fn(),
    detach: vi.fn(),
    resumeSettled: vi.fn(),
    agentStarted: vi.fn(),
    agentActive: vi.fn(),
    ensureRunning: vi.fn(),
    followSize: vi.fn(),
    fit: vi.fn(),
    focus: vi.fn(),
    dispose: vi.fn(),
    applySettings: vi.fn(),
    reconcileRenderers: vi.fn(),
  },
}))

beforeEach(() => {
  resetStore()
  vi.clearAllMocks()
  vi.mocked(ipc.listShells).mockResolvedValue([testShell])
})

describe("App (integration)", () => {
  it("renders the full chrome and opens an initial session", async () => {
    render(<App />)
    // Chrome is present immediately.
    expect(screen.getByText("minmux")).toBeInTheDocument()
    expect(screen.getByText("Sessions")).toBeInTheDocument()
    expect(screen.getByText("Search or run")).toBeInTheDocument()
    // Async effects: platform label + first session from listShells().
    expect(await screen.findByText("macOS")).toBeInTheDocument()
    await waitFor(() => expect(useStore.getState().tabs).toHaveLength(1))
  })

  it("polls git status for the focused session's cwd", async () => {
    render(<App />)
    await waitFor(() => expect(useStore.getState().tabs).toHaveLength(1))
    const id = Object.keys(useStore.getState().sessions)[0]!
    useStore.getState().setSessionCwd(id, "/repo")
    await waitFor(() => expect(ipc.gitStatus).toHaveBeenCalledWith("/repo", undefined)) // no WSL ctx for a native shell
  })

  it("loads settings before restoring, then paints the theme once (no default-theme flash)", async () => {
    vi.mocked(ipc.readSettings).mockResolvedValue('{"theme":"gruvbox","appearance":"light"}')
    render(<App />)
    await waitFor(() => expect(useStore.getState().tabs).toHaveLength(1))
    expect(useStore.getState().settings).toMatchObject({ theme: "gruvbox", appearance: "light" })
    // Only the loaded (light) theme ever reached the window — never the dark default.
    expect(ipc.setWindowBackground).toHaveBeenCalledWith("#f9f5d7")
    expect(ipc.setWindowBackground).not.toHaveBeenCalledWith("#0b0b0d")
    expect(document.documentElement.style.getPropertyValue("--bg")).toBe("#f9f5d7")
  })

  it("resume on relaunch: the pane spawns in the session's cwd and gets a pending resume", async () => {
    const sid = "s1"
    vi.mocked(ipc.readWorkspace).mockResolvedValue(
      JSON.stringify({
        version: 2,
        activeTabId: "t",
        tabs: [
          {
            id: "t",
            title: "",
            root: { type: "leaf", id: "p", sessionIds: [sid], activeSessionId: sid },
            activeSessionId: sid,
          },
        ],
        sessions: [{ id: sid, title: "zsh", command: "/bin/zsh", args: [], cwd: "/elsewhere" }],
      }),
    )
    const plan = {
      status: "resume" as const,
      sessionId: "7fe87f63-8ccf-437e-b991-94aa4ee44a0e",
      cwd: "/repo",
      command: "claude --resume 7fe87f63-8ccf-437e-b991-94aa4ee44a0e",
    }
    vi.mocked(ipc.resumePlan).mockResolvedValue({ [sid]: plan })
    render(<App />)
    await waitFor(() => expect(useStore.getState().resume[sid]?.phase).toBe("pending"))
    expect(useStore.getState().sessions[sid]?.cwd).toBe("/repo")
    expect(ipc.resumePlan).toHaveBeenCalledWith([sid], false)
  })

  it("ask mode keeps the pane's own cwd", async () => {
    const sid = "s2"
    vi.mocked(ipc.readSettings).mockResolvedValueOnce('{"resumeAgents":"ask"}')
    vi.mocked(ipc.readWorkspace).mockResolvedValue(
      JSON.stringify({
        version: 2,
        activeTabId: "t",
        tabs: [
          {
            id: "t",
            title: "",
            root: { type: "leaf", id: "p", sessionIds: [sid], activeSessionId: sid },
            activeSessionId: sid,
          },
        ],
        sessions: [{ id: sid, title: "zsh", command: "/bin/zsh", args: [], cwd: "/repo/sub" }],
      }),
    )
    vi.mocked(ipc.resumePlan).mockResolvedValue({
      [sid]: { status: "resume", sessionId: "x", cwd: "/repo", command: "claude --resume x" },
    })
    render(<App />)
    await waitFor(() => expect(useStore.getState().resume[sid]?.phase).toBe("offer"))
    // ask mode: the pane stays where it was (a Dismiss leaves it there); the typed command
    // cd's into the session's dir itself (terminal-manager, POSIX shells)
    expect(useStore.getState().sessions[sid]?.cwd).toBe("/repo/sub")
  })

  it("Claude's SessionStart from the pane confirms the resume — only for the same session", async () => {
    const sid = "s3"
    const id = "7fe87f63-8ccf-437e-b991-94aa4ee44a0e"
    vi.mocked(ipc.readWorkspace).mockResolvedValue(
      JSON.stringify({
        version: 2,
        activeTabId: "t",
        tabs: [
          {
            id: "t",
            title: "",
            root: { type: "leaf", id: "p", sessionIds: [sid], activeSessionId: sid },
            activeSessionId: sid,
          },
        ],
        sessions: [{ id: sid, title: "zsh", command: "/bin/zsh", args: [], cwd: "/repo" }],
      }),
    )
    vi.mocked(ipc.resumePlan).mockResolvedValue({
      [sid]: { status: "resume", sessionId: id, cwd: "/repo", command: `claude --resume ${id}` },
    })
    render(<App />)
    await waitFor(() => expect(useStore.getState().resume[sid]?.phase).toBe("pending"))
    const plan = useStore.getState().resume[sid]!.plan
    useStore.getState().setResume(sid, { phase: "resuming", plan }) // the command was typed
    const calls = vi.mocked(ipc.onAgentEvents).mock.calls
    const onEvents = calls[calls.length - 1]![0]
    // a different Claude started instead (e.g. the user typed `claude`) → not a resume
    onEvents([{ event: "SessionStart", sessionId: "other", paneId: sid }])
    expect(useStore.getState().resume[sid]?.phase).toBe("resuming")
    // the resumed session itself → resumed
    onEvents([{ event: "SessionStart", sessionId: id, paneId: sid, source: "resume" }])
    expect(useStore.getState().resume[sid]?.phase).toBe("resumed")
  })

  it("a skipped plan (transcript gone) shows the banner and is consumed right away", async () => {
    const sid = "s4"
    vi.mocked(ipc.readWorkspace).mockResolvedValue(
      JSON.stringify({
        version: 2,
        activeTabId: "t",
        tabs: [
          {
            id: "t",
            title: "",
            root: { type: "leaf", id: "p", sessionIds: [sid], activeSessionId: sid },
            activeSessionId: sid,
          },
        ],
        sessions: [{ id: sid, title: "zsh", command: "/bin/zsh", args: [], cwd: "/repo" }],
      }),
    )
    vi.mocked(ipc.resumePlan).mockResolvedValue({
      [sid]: { status: "skip", sessionId: "x", cwd: "/repo", reason: "its transcript is gone" },
    })
    render(<App />)
    await waitFor(() => expect(useStore.getState().resume[sid]?.phase).toBe("skipped"))
    expect(ipc.resumeConsume).toHaveBeenCalledWith(sid, "x")
  })
})

describe("App — ssh hosts", () => {
  it("loads the host list and re-fetches it when main says it changed", async () => {
    let changed: (() => void) | undefined
    vi.mocked(ipc.onSshHostsChanged).mockImplementation((cb) => {
      changed = cb
      return () => {}
    })
    vi.mocked(ipc.listSshHosts).mockResolvedValueOnce([testHost("web")])
    render(<App />)
    await waitFor(() => expect(useStore.getState().sshHosts.map((h) => h.label)).toEqual(["web"]), {
      timeout: 2000,
    })
    vi.mocked(ipc.listSshHosts).mockResolvedValueOnce([testHost("web"), testHost("db")])
    changed!()
    await waitFor(() => expect(useStore.getState().sshHosts).toHaveLength(2))
  })

  it("a late host list never overwrites a newer one", async () => {
    let changed: (() => void) | undefined
    vi.mocked(ipc.onSshHostsChanged).mockImplementation((cb) => {
      changed = cb
      return () => {}
    })
    let resolveFirst: (h: ReturnType<typeof testHost>[]) => void = () => {}
    vi.mocked(ipc.listSshHosts)
      .mockImplementationOnce(() => new Promise((r) => (resolveFirst = r)))
      .mockResolvedValueOnce([testHost("new")])
    render(<App />)
    await waitFor(() => expect(changed).toBeDefined())
    changed!()
    await waitFor(() => expect(useStore.getState().sshHosts.map((h) => h.label)).toEqual(["new"]))
    resolveFirst([testHost("old")])
    await new Promise((r) => setTimeout(r, 10))
    expect(useStore.getState().sshHosts.map((h) => h.label)).toEqual(["new"])
  })
})

describe("App — remote panes", () => {
  it("never polls local git for a focused remote pane", async () => {
    render(<App />)
    await waitFor(() => expect(useStore.getState().tabs).toHaveLength(1))
    vi.mocked(ipc.gitStatus).mockClear()
    useStore.getState().newTab(hostShellOption(testHost("web")))
    const id = useStore.getState().tabs[1]!.activeSessionId
    useStore.getState().setSessionCwd(id, "/home/me") // a remote OSC 7: ignored
    await new Promise((r) => setTimeout(r, 20))
    expect(ipc.gitStatus).not.toHaveBeenCalled()
    expect(useStore.getState().git).toBeNull()
  })
})

describe("App — ssh hosts without a backend", () => {
  it("a host fetch that throws synchronously doesn't take the app down", async () => {
    vi.mocked(ipc.listSshHosts).mockImplementation(() => {
      throw new TypeError("no backend")
    })
    render(<App />)
    await waitFor(() => expect(useStore.getState().tabs).toHaveLength(1))
    await waitFor(() => expect(ipc.listSshHosts).toHaveBeenCalled(), { timeout: 2000 })
    expect(screen.getByText("Sessions")).toBeInTheDocument()
  })

  it("fetches the hosts only after startup, not at mount", async () => {
    render(<App />)
    expect(ipc.listSshHosts).not.toHaveBeenCalled()
    await waitFor(() => expect(ipc.listSshHosts).toHaveBeenCalledTimes(1), { timeout: 2000 })
  })
})

describe("App — a host list main couldn't build", () => {
  it("keeps the last list instead of wiping it", async () => {
    let changed: (() => void) | undefined
    vi.mocked(ipc.onSshHostsChanged).mockImplementation((cb) => {
      changed = cb
      return () => {}
    })
    vi.mocked(ipc.listSshHosts)
      .mockResolvedValueOnce([testHost("web")])
      .mockResolvedValueOnce(null)
    render(<App />)
    await waitFor(() => expect(useStore.getState().sshHosts).toHaveLength(1), { timeout: 2000 })
    changed!()
    await waitFor(() => expect(ipc.listSshHosts).toHaveBeenCalledTimes(2))
    await new Promise((r) => setTimeout(r, 10))
    expect(useStore.getState().sshHosts.map((h) => h.label)).toEqual(["web"])
  })
})
