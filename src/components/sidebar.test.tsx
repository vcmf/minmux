import { describe, it, expect, beforeEach, vi } from "vitest"
import { render, screen, fireEvent, act } from "@testing-library/react"
import { Sidebar } from "./sidebar"
import { useStore } from "../store"
import { allSessionIds } from "../lib/pane-tree"
import { resetStore, testHost, testShell } from "../test/helpers"
import { ipc } from "../lib/ipc"
import { hostShellOption } from "../lib/ssh-hosts-ui"

vi.mock("../terminal/terminal-manager", () => ({
  TerminalManager: { attach: vi.fn(), fit: vi.fn(), focus: vi.fn(), dispose: vi.fn() },
}))

const st = () => useStore.getState()

beforeEach(() => {
  resetStore()
  vi.clearAllMocks()
})

describe("Sidebar", () => {
  it("renders the header, legend, and session tree", () => {
    st().newTab(testShell)
    st().renameTab(st().tabs[0]!.id, "work")
    render(<Sidebar />)
    expect(screen.getByText("Sessions")).toBeInTheDocument()
    expect(screen.getByText("work")).toBeInTheDocument() // session (tab) row
    expect(screen.getByText("1 pane")).toBeInTheDocument()
    expect(screen.getByText("running")).toBeInTheDocument()
    expect(screen.getByText("needs input")).toBeInTheDocument()
  })

  it("the header + button opens a new session (tab)", () => {
    render(<Sidebar />)
    expect(st().tabs).toHaveLength(0)
    fireEvent.click(screen.getByTitle("New session"))
    expect(st().tabs).toHaveLength(1)
  })

  it("shows a pane row per session with its status word", () => {
    st().newTab(testShell)
    render(<Sidebar />)
    // "idle" appears both as the pane meta and the legend
    expect(screen.getAllByText("idle").length).toBeGreaterThanOrEqual(1)
    // shell-type badge is shown (uppercased via CSS; textContent is "sh")
    expect(screen.getAllByText("sh").length).toBeGreaterThan(0)
  })

  it("shows the attention reason as a subline", () => {
    st().newTab(testShell)
    const id = allSessionIds(st().tabs[0]!.root)[0]!
    useStore.setState((s) => ({
      sessions: {
        ...s.sessions,
        [id]: { ...s.sessions[id]!, status: "attention", detail: "Claude needs your permission" },
      },
    }))
    render(<Sidebar />)
    expect(screen.getByText("Claude needs your permission")).toBeInTheDocument()
  })

  it("clicking a pane row focuses that session", () => {
    st().newTab(testShell)
    st().splitActive("row", testShell)
    const ids = allSessionIds(st().tabs[0]!.root)
    // Distinct cwds → distinct derived titles so we can target one pane.
    st().setSessionCwd(ids[0]!, "/w/alpha")
    st().setSessionCwd(ids[1]!, "/w/beta")
    render(<Sidebar />)
    fireEvent.mouseDown(screen.getByText("alpha"))
    expect(st().tabs[0]!.activeSessionId).toBe(ids[0])
  })
})

describe("Sidebar — Claude icon", () => {
  it("a terminal running Claude shows the Claude icon; back to the terminal icon when it ends", () => {
    st().newTab(testShell)
    const id = allSessionIds(st().tabs[0]!.root)[0]!
    const { container } = render(<Sidebar />)
    const icon = () => container.querySelector('[data-icon="claude"]')
    expect(icon()).toBeNull()
    act(() => st().applyAgentEvents([{ event: "SessionStart", sessionId: "c1", paneId: id }]))
    expect(icon()).not.toBeNull()
    act(() => st().claudeExited(id)) // prompt came back without a SessionEnd (crash)
    expect(icon()).toBeNull()
  })
})

describe("Sidebar — branch, PR and Claude snippet", () => {
  it("shows the terminal's branch, its PR (link opens it) and Claude's last reply", async () => {
    const { ipc } = await import("../lib/ipc")
    st().newTab(testShell)
    const id = st().tabs[0]!.activeSessionId
    st().setSessionCwd(id, "/w/term")
    st().setPaneGit(
      { [id]: { branch: "feat/x", pr: { number: 51, state: "merged", url: "https://x/51" } } },
      [id],
    )
    st().applyAgentEvents([
      { event: "SessionStart", sessionId: "c1", paneId: id },
      { event: "Stop", sessionId: "c1", paneId: id, message: "**All done** — PR is up." },
    ])
    render(<Sidebar />)
    expect(screen.getAllByText(/feat\/x/).length).toBeGreaterThan(0)
    expect(screen.getByText("merged")).toBeInTheDocument()
    expect(screen.getByText("All done — PR is up.")).toBeInTheDocument()
    fireEvent.click(screen.getByText("PR #51"))
    expect(ipc.openExternal).toHaveBeenCalledWith("https://x/51")
  })
})

describe("Sidebar — from / in folders", () => {
  const setup = () => {
    st().newTab(testShell)
    const id = st().tabs[0]!.activeSessionId
    st().setSessionCwd(id, "/w/term")
    return id
  }

  it("one folder line for a `cd` inside the same checkout (same repo root)", () => {
    const id = setup()
    st().applyAgentEvents([
      { event: "SessionStart", sessionId: "c1", paneId: id, cwd: "/w/term/src" },
    ])
    st().setPaneGit(
      { [id]: { root: "/w/term" }, [`${id}@in`]: { root: "/w/term", forCwd: "/w/term/src" } },
      [],
    )
    render(<Sidebar />)
    expect(screen.queryByText("from")).toBeNull()
  })

  it("one folder line while Claude works where it started", () => {
    const id = setup()
    st().applyAgentEvents([{ event: "SessionStart", sessionId: "c1", paneId: id, cwd: "/w/term" }])
    render(<Sidebar />)
    expect(screen.queryByText("from")).toBeNull()
    expect(screen.queryByText("in")).toBeNull()
  })

  it("from + in once Claude moves into another checkout (a worktree); each keeps its PR; +N", () => {
    const id = setup()
    st().applyAgentEvents([
      { event: "SessionStart", sessionId: "c1", paneId: id, cwd: "/w/term" },
      { event: "WorktreeCreate", sessionId: "c1", paneId: id, worktreePath: "/w/term/wt/b" },
      { event: "CwdChanged", sessionId: "c1", paneId: id, cwd: "/w/term/.claude/worktrees/a" },
    ])
    st().setPaneGit(
      {
        [id]: {
          branch: "main",
          root: "/w/term",
          pr: { number: 1, state: "merged", url: "https://x/1" },
        },
        [`${id}@in`]: {
          branch: "feat/a",
          root: "/w/term/.claude/worktrees/a",
          forCwd: "/w/term/.claude/worktrees/a",
          pr: { number: 57, state: "open", url: "https://x/57" },
        },
      },
      [id, `${id}@in`],
    )
    render(<Sidebar />)
    expect(screen.getByText("from")).toBeInTheDocument()
    expect(screen.getByText("in")).toBeInTheDocument()
    expect(screen.getByText(/feat\/a • \.claude\/worktrees\/a/)).toBeInTheDocument()
    expect(screen.getByText("PR #57")).toBeInTheDocument()
    expect(screen.getByText("PR #1")).toBeInTheDocument() // the session's own branch PR stays
    expect(screen.getByText("+1")).toHaveAttribute("title", expect.stringContaining("/w/term/wt/b"))
  })

  it("back to one line when Claude exits; closing the pane drops its `in` git info", () => {
    const id = setup()
    st().applyAgentEvents([{ event: "SessionStart", sessionId: "c1", paneId: id, cwd: "/w/api" }])
    st().setPaneGit({ [`${id}@in`]: { branch: "dev", forCwd: "/w/api" } }, [`${id}@in`])
    render(<Sidebar />)
    expect(screen.getByText(/dev • \/w\/api/)).toBeInTheDocument()
    act(() => st().claudeExited(id))
    expect(screen.queryByText("in")).toBeNull()
    act(() => st().closeSurface(st().tabs[0]!.id, id))
    expect(st().paneGit[`${id}@in`]).toBeUndefined()
  })
})

describe("Sidebar — folder lines: full path + right-click menu", () => {
  const setup = () => {
    st().newTab(testShell)
    const id = st().tabs[0]!.activeSessionId
    st().setSessionCwd(id, "/Users/test/work/term")
    return id
  }

  it("every folder line shows its full path on hover (one line, and from / in)", () => {
    const id = setup()
    const { unmount, container } = render(<Sidebar />)
    const line = container.querySelector(".tree-dir")!
    expect(line).toHaveAttribute("title", "/Users/test/work/term")
    unmount()
    st().applyAgentEvents([{ event: "SessionStart", sessionId: "c", paneId: id, cwd: "/w/api" }])
    st().setPaneGit({ [`${id}@in`]: { real: "/w/api", forCwd: "/w/api" } }, [])
    render(<Sidebar />)
    expect(screen.getByText("from").parentElement).toHaveAttribute(
      "title",
      expect.stringContaining("/Users/test/work/term"),
    )
    expect(screen.getByText("in").parentElement).toHaveAttribute(
      "title",
      expect.stringContaining("/w/api"),
    )
  })

  it("right-click: copy the path, or open a terminal there beside that pane", async () => {
    const { ipc } = await import("../lib/ipc")
    const id = setup()
    const { container } = render(<Sidebar />)
    const line = () => container.querySelector(".tree-dir")!
    fireEvent.contextMenu(line())
    fireEvent.mouseDown(screen.getByText("Copy path"))
    expect(ipc.clipboardWrite).toHaveBeenCalledWith("/Users/test/work/term")
    fireEvent.contextMenu(line())
    fireEvent.mouseDown(screen.getByText("Open terminal here"))
    const tab = st().tabs[0]!
    expect(allSessionIds(tab.root)).toHaveLength(2) // split beside that pane…
    expect(tab.activeSessionId).not.toBe(id) // …and the new one is focused
    expect(st().sessions[tab.activeSessionId]?.cwd).toBe("/Users/test/work/term")
  })

  it("a right-click doesn't switch to / focus that pane (Escape would reach its Claude)", () => {
    const id = setup()
    st().newTab(testShell) // a second tab is now active
    const other = st().activeTabId
    useStore.setState({ platform: "darwin" }) // Ctrl-click = right-click there
    const { container } = render(<Sidebar />)
    const line = [...container.querySelectorAll(".tree-dir")].find((el) =>
      el.getAttribute("title")?.includes("/Users/test/work/term"),
    )!
    fireEvent.mouseDown(line, { button: 2 })
    fireEvent.mouseDown(line, { button: 0, ctrlKey: true }) // macOS Ctrl-click = right-click
    fireEvent.contextMenu(line)
    expect(st().activeTabId).toBe(other)
    fireEvent.mouseDown(line, { button: 0 }) // a plain left click still focuses it
    expect(st().activeTabId).not.toBe(other)
    void id
  })

  it("Open terminal here keeps the source pane's attention (you never looked at it)", () => {
    const id = setup()
    useStore.setState((x) => ({
      sessions: {
        ...x.sessions,
        [id]: { ...x.sessions[id]!, status: "attention", detail: "permission" },
      },
    }))
    const before = st().sessions[id]?.status
    expect(before).toBe("attention")
    const { container } = render(<Sidebar />)
    fireEvent.contextMenu(container.querySelector(".tree-dir")!)
    fireEvent.mouseDown(screen.getByText("Open terminal here"))
    expect(st().sessions[id]?.status).toBe(before)
  })

  it("Reveal is unavailable for a WSL pane's path", () => {
    st().newTab({ id: "wsl", label: "Ubuntu", command: "wsl.exe", args: ["-d", "Ubuntu"] })
    const id = st().tabs[0]!.activeSessionId
    st().setSessionCwd(id, "/home/u/repo")
    const { container } = render(<Sidebar />)
    fireEvent.contextMenu(container.querySelector(".tree-dir")!)
    expect(screen.getByText("WSL path")).toBeInTheDocument()
    expect(screen.getByText(/Reveal in|Show in/).closest("button")).toBeDisabled()
  })
})

describe("Sidebar — Remote hosts", () => {
  beforeEach(() => {
    try {
      localStorage.clear()
    } catch {
      // no storage in this environment
    }
  })

  it("lists saved hosts with their detail, without env headings for one env", () => {
    st().setSshHosts([testHost("web", "native", "me@10.0.0.1"), testHost("db")])
    render(<Sidebar />)
    expect(screen.getByText("Remote")).toBeInTheDocument()
    expect(screen.getByText("web")).toBeInTheDocument()
    expect(screen.getByText("me@10.0.0.1")).toBeInTheDocument()
    expect(screen.getByText("db")).toBeInTheDocument()
    expect(screen.queryByText("This machine")).not.toBeInTheDocument()
  })

  it("groups by environment when there's more than one", () => {
    st().setSshHosts([testHost("web"), testHost("gpu", "wsl:Ubuntu")])
    render(<Sidebar />)
    expect(screen.getByText("This machine")).toBeInTheDocument()
    expect(screen.getByText("WSL: Ubuntu")).toBeInTheDocument()
  })

  it("clicking a host opens a new tab on it", () => {
    st().setSshHosts([testHost("web")])
    render(<Sidebar />)
    fireEvent.click(screen.getByTitle("Open a terminal on web"))
    expect(st().tabs).toHaveLength(1)
    expect(st().sessions[st().tabs[0]!.activeSessionId]!.remote?.hostId).toBe("native:web")
  })

  it("the hover split buttons split the active pane onto the host, not a new tab", () => {
    st().newTab(testShell)
    st().setSshHosts([testHost("web")])
    render(<Sidebar />)
    fireEvent.click(screen.getByTitle("Split right on web"))
    expect(st().tabs).toHaveLength(1)
    const tab = st().tabs[0]!
    expect(tab.root.type === "split" && tab.root.direction).toBe("row")
    expect(st().sessions[tab.activeSessionId]!.remote?.hostId).toBe("native:web")
    fireEvent.click(screen.getByTitle("Split down on web"))
    expect(allSessionIds(st().tabs[0]!.root)).toHaveLength(3)
  })

  it("marks hosts with a live session as connected", () => {
    st().setSshHosts([testHost("web"), testHost("db")])
    st().newTab(hostShellOption(testHost("web")))
    st().setRemotePhase(st().tabs[0]!.activeSessionId, "live")
    render(<Sidebar />)
    expect(screen.getAllByTitle("Connected")).toHaveLength(1)
    const row = screen.getByTitle("Open a terminal on web").closest(".remote-row")!
    expect(row.querySelector('[title="Connected"]')).not.toBeNull()
  })

  it("an empty list says so and offers to open the ssh config", () => {
    st().setSshHosts([])
    render(<Sidebar />)
    expect(screen.getByText("No hosts in ~/.ssh/config")).toBeInTheDocument()
    fireEvent.click(screen.getByText("Open ssh config"))
    expect(ipc.openSshConfig).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByTitle("Open ssh config"))
    expect(ipc.openSshConfig).toHaveBeenCalledTimes(2)
  })

  it("collapses, and remembers it", () => {
    st().setSshHosts([testHost("web")])
    const { unmount } = render(<Sidebar />)
    fireEvent.click(screen.getByText("Remote"))
    expect(screen.queryByTitle("Open a terminal on web")).not.toBeInTheDocument()
    unmount()
    render(<Sidebar />)
    expect(screen.queryByTitle("Open a terminal on web")).not.toBeInTheDocument()
    fireEvent.click(screen.getByText("Remote"))
    expect(screen.getByTitle("Open a terminal on web")).toBeInTheDocument()
  })

  it("a remote pane row shows the host, a globe and no local folder line or menu", () => {
    st().newTab(hostShellOption(testHost("gpu", "wsl:Ubuntu")))
    render(<Sidebar />)
    const sub = screen.getByText("gpu · WSL: Ubuntu")
    expect(screen.queryByText("shell")).not.toBeInTheDocument() // the no-cwd folder line
    fireEvent.contextMenu(sub)
    expect(screen.queryByText("Copy path")).not.toBeInTheDocument()
  })
})

describe("Sidebar — Remote hosts, accessibly", () => {
  it("a host's label is a real button (Enter/Space for free); the splits are its siblings", () => {
    st().setSshHosts([testHost("web")])
    render(<Sidebar />)
    const open = screen.getByTitle("Open a terminal on web")
    expect(open.tagName).toBe("BUTTON")
    expect(open.querySelector("button")).toBeNull()
    expect(open.contains(screen.getByTitle("Split right on web"))).toBe(false)
  })
})

describe("Sidebar — before the first host list arrives", () => {
  it("shows no empty state until main has answered", () => {
    render(<Sidebar />)
    expect(screen.queryByText("No hosts in ~/.ssh/config")).not.toBeInTheDocument()
    act(() => st().setSshHosts([]))
    expect(screen.getByText("No hosts in ~/.ssh/config")).toBeInTheDocument()
  })
})

describe("Sidebar — a dropped connection", () => {
  it("the host's connected dot goes away while its only pane is closed", () => {
    st().setSshHosts([testHost("web")])
    st().newTab(hostShellOption(testHost("web")))
    st().setRemotePhase(st().tabs[0]!.activeSessionId, "live")
    render(<Sidebar />)
    expect(screen.getAllByTitle("Connected")).toHaveLength(1)
    act(() => st().setRemotePhase(st().tabs[0]!.activeSessionId, "closed"))
    expect(screen.queryByTitle("Connected")).not.toBeInTheDocument()
  })
})

describe("Sidebar — ssh pane states", () => {
  it("each state reads as its own word on the pane row", () => {
    st().newTab(hostShellOption(testHost("web")))
    const id = st().tabs[0]!.activeSessionId
    const { rerender } = render(<Sidebar />)
    for (const [phase, detail, word] of [
      ["starting", undefined, "connecting"],
      ["prompt", "password", "password"],
      ["closed", undefined, "disconnected"],
      ["failed", "host-gone", "can't connect"],
      ["waiting", undefined, "not connected"],
    ] as const) {
      act(() => st().setRemotePhase(id, phase, detail))
      rerender(<Sidebar />)
      expect(screen.getByText(word)).toBeInTheDocument()
    }
    act(() => st().setRemotePhase(id, "live"))
    rerender(<Sidebar />)
    expect(screen.getAllByText("idle").length).toBeGreaterThan(0)
  })
})

describe("Sidebar — remote pane rows", () => {
  it("the subline is where it runs (user@hostname), not the alias again", () => {
    st().setSshHosts([testHost("web", "native", "me@10.0.0.1")])
    st().newTab(hostShellOption(testHost("web")))
    render(<Sidebar />)
    const rows = screen.getAllByText("me@10.0.0.1")
    expect(rows.some((el) => el.classList.contains("tree-sub"))).toBe(true)
    expect(screen.queryByText("ssh · web")).not.toBeInTheDocument()
  })
})
