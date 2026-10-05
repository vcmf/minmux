import { describe, it, expect, beforeEach, vi } from "vitest"
import { render, screen, fireEvent, act } from "@testing-library/react"
import { Sidebar } from "./sidebar"
import { useStore } from "../store"
import { allSessionIds } from "../lib/pane-tree"
import { resetStore, testHost, testShell } from "../test/helpers"
import { ipc } from "../lib/ipc"
import { TerminalManager } from "../terminal/terminal-manager"
import { hostShellOption } from "../lib/ssh-hosts-ui"
import type { SshHost } from "../types"

vi.mock("../terminal/terminal-manager", () => ({
  TerminalManager: { attach: vi.fn(), fit: vi.fn(), focus: vi.fn(), dispose: vi.fn() },
}))

const st = () => useStore.getState()

/** Hosts from main, pinned so the sidebar lists them (it shows pinned + open ones). */
const showHosts = (hosts: SshHost[]) => {
  st().setSshHosts(hosts)
  useStore.setState((s) => ({
    settings: { ...s.settings, ssh: { ...s.settings.ssh, pinned: hosts.map((h) => h.hostId) } },
  }))
}

/** The Remote section's remembered choice: most tests look inside it, so they start it open. */
const REMOTE_KEY = "minmux.sidebar.remoteCollapsed"

beforeEach(() => {
  resetStore()
  vi.clearAllMocks()
  localStorage.setItem(REMOTE_KEY, "0")
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
    act(() => st().agentExited(id)) // prompt came back without a SessionEnd (crash)
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
    act(() => st().agentExited(id))
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
    localStorage.setItem(REMOTE_KEY, "0")
  })

  it("lists saved hosts with their detail, without env headings for one env", () => {
    showHosts([testHost("web", "native", "me@10.0.0.1"), testHost("db")])
    render(<Sidebar />)
    expect(screen.getByText("Remote")).toBeInTheDocument()
    expect(screen.getByText("web")).toBeInTheDocument()
    expect(screen.getByText("me@10.0.0.1")).toBeInTheDocument()
    expect(screen.getByText("db")).toBeInTheDocument()
    expect(screen.queryByText("This machine")).not.toBeInTheDocument()
  })

  it("groups by environment when there's more than one", () => {
    showHosts([testHost("web"), testHost("gpu", "wsl:Ubuntu")])
    render(<Sidebar />)
    expect(screen.getByText("This machine")).toBeInTheDocument()
    expect(screen.getByText("WSL: Ubuntu")).toBeInTheDocument()
  })

  it("clicking a host opens a new tab on it", () => {
    showHosts([testHost("web")])
    render(<Sidebar />)
    fireEvent.click(screen.getByTitle("Open a terminal on web"))
    expect(st().tabs).toHaveLength(1)
    expect(st().sessions[st().tabs[0]!.activeSessionId]!.remote?.hostId).toBe("native:web")
  })

  it("the hover split buttons split the active pane onto the host, not a new tab", () => {
    st().newTab(testShell)
    showHosts([testHost("web")])
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
    showHosts([testHost("web"), testHost("db")])
    st().newTab(hostShellOption(testHost("web")))
    st().setRemotePhase(st().tabs[0]!.activeSessionId, "live")
    render(<Sidebar />)
    expect(screen.getAllByTitle("Connected")).toHaveLength(1)
    const row = screen.getByTitle("Open a terminal on web").closest(".remote-row")!
    expect(row.querySelector('[title="Connected"]')).not.toBeNull()
  })

  it("an empty list says so and offers to open the ssh config", () => {
    showHosts([])
    render(<Sidebar />)
    expect(screen.getByText(/Hosts come from the/)).toBeInTheDocument()
    fireEvent.click(screen.getByText("Open ssh config"))
    expect(ipc.openSshConfig).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByTitle("Open ssh config"))
    expect(ipc.openSshConfig).toHaveBeenCalledTimes(2)
  })

  it("collapses, and remembers it", () => {
    showHosts([testHost("web")])
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
    showHosts([testHost("web")])
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
    expect(screen.queryByText(/Hosts come from the/)).not.toBeInTheDocument()
    act(() => st().setSshHosts([]))
    expect(screen.getByText(/Hosts come from the/)).toBeInTheDocument()
  })
})

describe("Sidebar — a dropped connection", () => {
  it("the host's connected dot goes away while its only pane is closed", () => {
    showHosts([testHost("web")])
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
    showHosts([testHost("web", "native", "me@10.0.0.1")])
    st().newTab(hostShellOption(testHost("web")))
    render(<Sidebar />)
    const rows = screen.getAllByText("me@10.0.0.1")
    expect(rows.some((el) => el.classList.contains("tree-sub"))).toBe(true)
    expect(screen.queryByText("ssh · web")).not.toBeInTheDocument()
  })
})

describe("Sidebar — Remote shows pinned and open hosts", () => {
  it("unpinned hosts with nothing open stay in the picker; All hosts (N)… opens it", () => {
    st().setSshHosts([testHost("web"), testHost("db"), { ...testHost("github.com"), hidden: true }])
    render(<Sidebar />)
    expect(screen.queryByTitle("Open a terminal on web")).not.toBeInTheDocument()
    expect(screen.getByText(/Pinned hosts and hosts you/)).toBeInTheDocument()
    fireEvent.click(screen.getByText("All hosts (2)…"))
    expect(st().hostPickerOpen).toBe(true)
  })

  it("a host with a pane open is listed; a pinned one is marked", () => {
    st().setSshHosts([testHost("web"), testHost("db")])
    useStore.setState((s) => ({
      settings: { ...s.settings, ssh: { ...s.settings.ssh, pinned: ["native:db"] } },
    }))
    st().newTab(hostShellOption(testHost("web")))
    render(<Sidebar />)
    const rows = [...document.querySelectorAll(".remote-row .tree-primary")].map(
      (e) => e.textContent,
    )
    expect(rows).toEqual(["db", "web"]) // pinned first
    expect(screen.getAllByLabelText("Pinned")).toHaveLength(1)
  })

  it("right-click a host row: unpin, or hide it", () => {
    st().setSshHosts([testHost("db")])
    useStore.setState((s) => ({
      settings: { ...s.settings, ssh: { ...s.settings.ssh, pinned: ["native:db"] } },
    }))
    render(<Sidebar />)
    fireEvent.contextMenu(document.querySelector(".remote-row")!)
    fireEvent.mouseDown(screen.getByText("Hide host"))
    expect(st().settings.ssh.hidden).toContain("db")
    fireEvent.contextMenu(document.querySelector(".remote-row")!)
    fireEvent.mouseDown(screen.getByText("Unpin from sidebar"))
    expect(st().settings.ssh.pinned).toEqual([])
  })

  it("the search button opens the host picker", () => {
    render(<Sidebar />)
    fireEvent.click(screen.getByTitle("Connect to host…"))
    expect(st().hostPickerOpen).toBe(true)
  })
})

describe("Sidebar — a restored ssh pane not started yet", () => {
  it("reads as not connected under on-focus (it's waiting, like the started ones)", () => {
    st().newTab(hostShellOption(testHost("web")))
    const id = st().tabs[0]!.activeSessionId
    useStore.setState((s) => ({
      sessions: { ...s.sessions, [id]: { ...s.sessions[id]!, restored: true } },
      settings: { ...s.settings, ssh: { ...s.settings.ssh, restore: "on-focus" } },
    }))
    render(<Sidebar />)
    expect(screen.getByText("not connected")).toBeInTheDocument()
  })
})

describe("Sidebar — an ssh pane's row", () => {
  it("the remote folder's name, the host boxed, and the path below", () => {
    st().setSshHosts([testHost("gpu-box", "native", "quang@10.0.4.12")])
    st().newTab(hostShellOption(testHost("gpu-box")))
    st().setRemoteCwd(st().tabs[0]!.activeSessionId, "~/projects/llm-train")
    render(<Sidebar />)
    expect(screen.getByText("llm-train")).toHaveClass("tree-primary")
    const box = document.querySelector(".host-box") as HTMLElement
    expect(box.textContent).toBe("gpu-box")
    expect(box.title).toBe("quang@10.0.4.12")
    expect(screen.getByText("~/projects/llm-train")).toHaveClass("tree-sub")
  })

  it("folder unknown: the host's name with the SSH badge (not the host twice), user@hostname below", () => {
    st().setSshHosts([testHost("gpu-box", "native", "quang@10.0.4.12")])
    st().newTab(hostShellOption(testHost("gpu-box")))
    render(<Sidebar />)
    expect(document.querySelector(".tree .host-box")).toBeNull()
    const subs = [...document.querySelectorAll(".tree .tree-sub")].map((e) => e.textContent)
    expect(subs).toContain("quang@10.0.4.12")
  })

  it("at the host user's home the headline is ~; a WSL pane keeps its distro", () => {
    st().setSshHosts([testHost("gpu", "wsl:Ubuntu", "quang@10.0.4.12")])
    st().newTab(hostShellOption(testHost("gpu", "wsl:Ubuntu")))
    st().setRemoteCwd(st().tabs[0]!.activeSessionId, "/home/quang")
    render(<Sidebar />)
    expect(screen.getByText("~", { selector: ".tree-primary" })).toBeInTheDocument()
    const subs = [...document.querySelectorAll(".tree .tree-sub")].map((e) => e.textContent)
    expect(subs).toContain("~ · WSL: Ubuntu")
  })
})

describe("Sidebar — Remote header", () => {
  it("starts collapsed when you've never chosen", () => {
    localStorage.removeItem(REMOTE_KEY)
    showHosts([testHost("web")])
    render(<Sidebar />)
    expect(screen.getByText("Remote").closest("button")).toHaveAttribute("aria-expanded", "false")
    expect(screen.queryByTitle("Open a terminal on web")).not.toBeInTheDocument()
  })

  it("shows connections, and whether one is connecting, needs you or is down", () => {
    st().setSshHosts([testHost("web"), testHost("db"), testHost("pi"), testHost("x")])
    for (const h of ["web", "db", "pi", "x"]) st().newTab(hostShellOption(testHost(h)))
    const [a, b, c, d] = st().tabs.map((t) => t.activeSessionId)
    st().setRemotePhase(a!, "live")
    st().setRemotePhase(b!, "prompt", "password")
    st().setRemotePhase(c!, "closed", "lost")
    st().setRemotePhase(d!, "closed", "retrying") // reconnecting on its own: not "needs you"
    render(<Sidebar />)
    const status = document.querySelector(".remote-status") as HTMLElement
    expect(status.querySelector(".remote-status-n")!.textContent).toBe("2") // web + db (prompt)
    expect(status.querySelector(".dot.faint.pulse")).not.toBeNull()
    expect(status.querySelectorAll(".dot.amber")).toHaveLength(1)
    expect(status.querySelector(".dot.red")).not.toBeNull()
    const text = "2 connections · 1 connecting · 1 needs you · 1 disconnected"
    expect(status.title).toBe(text)
    // Screen readers get it from the toggle's name (the dots themselves are aria-hidden).
    expect(screen.getByRole("button", { name: `Remote: ${text}` })).toBeInTheDocument()
  })

  it("nothing remote: no status at all", () => {
    st().setSshHosts([testHost("web")])
    render(<Sidebar />)
    expect(document.querySelector(".remote-status")).toBeNull()
  })
})

describe("Sidebar — hover × closes (through the confirm rules)", () => {
  it("session row: one idle terminal closes at once; several ask first", () => {
    st().newTab(testShell)
    const { unmount } = render(<Sidebar />)
    fireEvent.click(screen.getByTitle("Close session"))
    expect(st().tabs).toHaveLength(0)
    unmount()
    st().newTab(testShell)
    st().splitActive("row")
    render(<Sidebar />)
    fireEvent.click(screen.getByTitle("Close session"))
    expect(st().closeConfirm).toMatchObject({ kind: "tab", count: 2 })
    expect(st().tabs).toHaveLength(1)
  })

  it("terminal row: closes that terminal (idle), without focusing its row first", () => {
    st().newTab(testShell)
    st().splitActive("row")
    const [a] = allSessionIds(st().tabs[0]!.root)
    render(<Sidebar />)
    const close = screen.getAllByTitle("Close terminal")[0]!
    fireEvent.mouseDown(close)
    fireEvent.click(close)
    expect(allSessionIds(st().tabs[0]!.root)).not.toContain(a)
  })
})

describe("Sidebar — renaming a session", () => {
  /** The session (tab) row's name, its row, and the rename field (when shown). */
  const nameEl = (i = 0) =>
    document.querySelectorAll(".tree-group > .tree-row:first-child .tree-labels")[i]! as HTMLElement
  const rowEl = (i = 0) =>
    document.querySelectorAll(".tree-group > .tree-row:first-child")[i]! as HTMLElement
  const field = () => document.querySelector(".tree-rename") as HTMLInputElement | null
  const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r(undefined)))
  const startEdit = (i = 0) => {
    fireEvent.doubleClick(nameEl(i))
    return field()!
  }
  const openMenu = (i = 0) => fireEvent.contextMenu(rowEl(i), { clientX: 20, clientY: 30 })
  const menuItem = (label: string) =>
    [...document.querySelectorAll(".ctx-menu .shell-menu-item")].find((b) =>
      b.textContent?.startsWith(label),
    ) as HTMLButtonElement

  it("double-clicking the name opens a field with the live name, focused and selected", () => {
    st().newTab(testShell)
    render(<Sidebar />)
    const input = startEdit()
    expect(input.value).toBe("sh") // the live title (no cwd: the shell type)
    expect(document.activeElement).toBe(input)
    expect(input.selectionStart).toBe(0)
    expect(input.selectionEnd).toBe(input.value.length)
  })

  it("Enter saves the trimmed name, shows it, and gives the terminal its keyboard back", async () => {
    st().newTab(testShell)
    render(<Sidebar />)
    const input = startEdit()
    fireEvent.change(input, { target: { value: "  backend  " } })
    fireEvent.keyDown(input, { key: "Enter" })
    expect(st().tabs[0]!.title).toBe("backend")
    expect(field()).toBeNull()
    expect(screen.getByText("backend")).toBeInTheDocument()
    await nextFrame()
    expect(TerminalManager.focus).toHaveBeenCalledWith(st().tabs[0]!.activeSessionId)
  })

  it("a blur saves too (clicking elsewhere keeps what you typed)", () => {
    st().newTab(testShell)
    render(<Sidebar />)
    const input = startEdit()
    fireEvent.change(input, { target: { value: "api" } })
    fireEvent.blur(input)
    expect(st().tabs[0]!.title).toBe("api")
  })

  it("Escape cancels, even with the blur its unmount fires right after", () => {
    st().newTab(testShell)
    st().renameTab(st().tabs[0]!.id, "keep")
    render(<Sidebar />)
    const input = startEdit()
    fireEvent.change(input, { target: { value: "discard" } })
    // Chromium blurs a focused field as it's removed: both land before React re-renders.
    act(() => {
      fireEvent.keyDown(input, { key: "Escape" })
      fireEvent.blur(input)
    })
    expect(st().tabs[0]!.title).toBe("keep")
    expect(field()).toBeNull()
  })

  it("Enter then the unmount blur renames once", () => {
    st().newTab(testShell)
    render(<Sidebar />)
    const spy = vi.spyOn(st(), "renameTab")
    const input = startEdit()
    fireEvent.change(input, { target: { value: "once" } })
    act(() => {
      fireEvent.keyDown(input, { key: "Enter" })
      fireEvent.blur(input)
    })
    expect(spy).toHaveBeenCalledTimes(1)
    spy.mockRestore()
  })

  it("an empty or blank name changes nothing", () => {
    st().newTab(testShell)
    st().renameTab(st().tabs[0]!.id, "keep")
    render(<Sidebar />)
    const before = st().tabs
    const input = startEdit()
    fireEvent.change(input, { target: { value: "   " } })
    fireEvent.keyDown(input, { key: "Enter" })
    expect(st().tabs).toBe(before)
  })

  it("Enter and Escape stay in the field (never reach a window shortcut or the terminal)", () => {
    st().newTab(testShell)
    render(<Sidebar />)
    const onKey = vi.fn()
    window.addEventListener("keydown", onKey)
    const input = startEdit()
    fireEvent.keyDown(input, { key: "Escape" })
    window.removeEventListener("keydown", onKey)
    expect(onKey).not.toHaveBeenCalled()
  })

  it("pre-fills the name only, so a plain blur can't pin the live +N", () => {
    st().newTab(hostShellOption(testHost("gpu")))
    st().splitWith("row", testShell)
    render(<Sidebar />)
    const input = startEdit()
    expect(input.value).not.toContain("+")
    fireEvent.blur(input)
    expect(st().tabs[0]!.title).not.toContain("+")
  })

  it("while editing, the row can't be dragged and clicks in the field don't switch sessions", () => {
    st().newTab(testShell)
    st().newTab(testShell) // the second tab is active
    const [first] = st().tabs
    render(<Sidebar />)
    expect(rowEl(0).getAttribute("draggable")).toBe("true")
    openMenu(0) // a right-click doesn't select the session
    fireEvent.mouseDown(menuItem("Rename…"))
    expect(rowEl(0).getAttribute("draggable")).toBe("false")
    fireEvent.mouseDown(field()!)
    expect(st().activeTabId).not.toBe(first!.id)
    fireEvent.doubleClick(field()!) // a double-click selecting a word keeps the field
    expect(field()).not.toBeNull()
  })

  it("edits one session at a time: double-clicking another moves the field there", () => {
    st().newTab(testShell)
    st().newTab(testShell)
    render(<Sidebar />)
    const first = startEdit(0)
    fireEvent.change(first, { target: { value: "one" } })
    fireEvent.blur(first) // what moving to the other row does
    startEdit(1)
    expect(document.querySelectorAll(".tree-rename")).toHaveLength(1)
    expect(field()!.value).toBe("sh") // the second session's own name
    expect(screen.getByText("one")).toBeInTheDocument() // the first kept what was typed
  })
})

describe("Sidebar — a session's right-click menu", () => {
  const rowEl = (i = 0) =>
    document.querySelectorAll(".tree-group > .tree-row:first-child")[i]! as HTMLElement
  const field = () => document.querySelector(".tree-rename") as HTMLInputElement | null
  const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r(undefined)))
  const openMenu = (i = 0) => fireEvent.contextMenu(rowEl(i), { clientX: 20, clientY: 30 })
  const menuItem = (label: string) =>
    [...document.querySelectorAll(".ctx-menu .shell-menu-item")].find((b) =>
      b.textContent?.startsWith(label),
    ) as HTMLButtonElement | undefined

  it("Rename… opens the field, and the terminal doesn't steal its focus back", async () => {
    st().newTab(testShell)
    render(<Sidebar />)
    openMenu()
    fireEvent.mouseDown(menuItem("Rename…")!)
    expect(document.querySelector(".ctx-menu")).toBeNull()
    expect(document.activeElement).toBe(field())
    await nextFrame()
    expect(TerminalManager.focus).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(field())
  })

  it("Reset name is disabled until the session has a name of yours", () => {
    st().newTab(testShell)
    render(<Sidebar />)
    openMenu()
    expect(menuItem("Reset name")!.disabled).toBe(true)
    fireEvent.mouseDown(menuItem("Reset name")!) // a disabled item does nothing
    expect(st().tabs[0]!.title).toBe("")
  })

  it("Reset name goes back to the live title, in the sidebar and the store", async () => {
    st().newTab(testShell)
    st().renameTab(st().tabs[0]!.id, "mine")
    render(<Sidebar />)
    expect(screen.getByText("mine")).toBeInTheDocument()
    openMenu()
    fireEvent.mouseDown(menuItem("Reset name")!)
    expect(st().tabs[0]!.title).toBe("")
    expect(screen.queryByText("mine")).not.toBeInTheDocument()
    await nextFrame()
    expect(TerminalManager.focus).toHaveBeenCalled() // the menu hands the keyboard back
  })

  it("Close session closes it (via the same confirm path as the row's ×)", () => {
    st().newTab(testShell)
    st().newTab(testShell)
    const [first] = st().tabs
    render(<Sidebar />)
    openMenu(0)
    fireEvent.mouseDown(menuItem("Close session")!)
    expect(st().tabs.map((t) => t.id)).not.toContain(first!.id)
  })

  it("acts on the row it was opened on, not the active session", () => {
    st().newTab(testShell)
    st().newTab(testShell) // active
    render(<Sidebar />)
    st().renameTab(st().tabs[0]!.id, "first")
    openMenu(0)
    fireEvent.mouseDown(menuItem("Reset name")!)
    expect(st().tabs[0]!.title).toBe("")
    expect(st().tabs[1]!.title).toBe("")
  })

  it("disappears when its session is closed while it's open", () => {
    st().newTab(testShell)
    st().newTab(testShell)
    render(<Sidebar />)
    openMenu(0)
    expect(document.querySelector(".ctx-menu")).not.toBeNull()
    act(() => st().closeTab(st().tabs[0]!.id))
    expect(document.querySelector(".ctx-menu")).toBeNull()
  })
})
