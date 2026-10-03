import { describe, it, expect, beforeEach, vi } from "vitest"
import { render, screen, fireEvent, act } from "@testing-library/react"
import { AgentsPanel } from "./agents-panel"
import { useStore } from "../store"
import { reduceAgentEvents } from "../lib/agent-graph"
import { resetStore } from "../test/helpers"

// A root session (in pane "p") at /repo/app that created a worktree.
const seed = () =>
  reduceAgentEvents([
    { event: "SessionStart", sessionId: "s", cwd: "/repo/app", paneId: "p" },
    { event: "UserPromptSubmit", sessionId: "s" },
    {
      event: "WorktreeCreate",
      sessionId: "s",
      worktreePath: "/repo/.wt/feat",
      baseBranch: "feat/x",
    },
  ])

describe("AgentsPanel", () => {
  beforeEach(() => {
    resetStore()
    useStore.setState({ agents: seed() })
  })

  it("shows the session root's folder and its worktree branch", () => {
    render(<AgentsPanel />)
    expect(screen.getByText("app")).toBeInTheDocument() // base(/repo/app)
    expect(screen.getByText("feat/x")).toBeInTheDocument() // worktree branch
  })

  it("marks the worktree Claude works in now (`in`), not the others", () => {
    const { container } = render(<AgentsPanel />)
    expect(container.textContent).not.toContain("· in")
    const moveIn = { event: "CwdChanged", sessionId: "s", paneId: "p", cwd: "/repo/.wt/feat/" }
    act(() => useStore.getState().applyAgentEvents([moveIn]))
    expect(container.textContent).toContain("feat/x · in")
    const deeper = { ...moveIn, cwd: "/repo/.wt/feat/src" } // a subfolder of that worktree
    act(() => useStore.getState().applyAgentEvents([deeper]))
    expect(container.textContent).toContain("feat/x · in")
    // a worktree nested inside it: only the deepest one is `in`
    const nested = "/repo/.wt/feat/.claude/worktrees/b"
    act(() =>
      useStore.getState().applyAgentEvents([
        { event: "WorktreeCreate", sessionId: "s", worktreePath: nested, baseBranch: "feat/b" },
        { ...moveIn, cwd: nested },
      ]),
    )
    expect(container.textContent).toContain("feat/b · in")
    expect(container.textContent).not.toContain("feat/x · in")
  })

  it("clicking the folder opens a terminal there (agent's pane context)", () => {
    const spy = vi.fn()
    useStore.setState({ openFolderInSplit: spy })
    render(<AgentsPanel />)
    fireEvent.click(screen.getByTitle("Open a terminal here — /repo/app"))
    expect(spy).toHaveBeenCalledWith("/repo/app", "p")
  })

  it("clicking a worktree opens it", () => {
    const spy = vi.fn()
    useStore.setState({ openFolderInSplit: spy })
    render(<AgentsPanel />)
    fireEvent.click(screen.getByTitle("Open a terminal here — /repo/.wt/feat"))
    expect(spy).toHaveBeenCalledWith("/repo/.wt/feat", "p")
  })

  it("empty when no agents are running", () => {
    useStore.setState({ agents: reduceAgentEvents([]) })
    render(<AgentsPanel />)
    expect(screen.getByText(/No agents yet/)).toBeInTheDocument()
  })

  it("boxes the session whose pane the user is currently in", () => {
    useStore.setState({
      activeTabId: "t",
      tabs: [
        {
          id: "t",
          title: "t",
          root: { type: "leaf", id: "pp", sessionIds: ["p"], activeSessionId: "p" },
          activeSessionId: "p",
        },
      ],
    })
    const { container } = render(<AgentsPanel />)
    expect(container.querySelector(".agent-session.active")).toBeInTheDocument()
  })

  it("does not box a session whose pane is not focused", () => {
    useStore.setState({
      activeTabId: "t",
      tabs: [
        {
          id: "t",
          title: "t",
          root: { type: "leaf", id: "po", sessionIds: ["other"], activeSessionId: "other" },
          activeSessionId: "other",
        },
      ],
    })
    const { container } = render(<AgentsPanel />)
    expect(container.querySelector(".agent-session.active")).toBeNull()
  })

  it("shows a ↑context ↓output token badge once usage is known, not before", () => {
    const { container, rerender } = render(<AgentsPanel />)
    expect(container.querySelector(".tree-tokens")).toBeNull() // no tokens yet
    useStore.setState({
      agents: reduceAgentEvents([
        { event: "SessionStart", sessionId: "s", cwd: "/repo/app", paneId: "p" },
        { event: "TokenUsage", sessionId: "s", tokens: { context: 148_000, output: 1200 } },
      ]),
    })
    rerender(<AgentsPanel />)
    expect(container.querySelector(".tree-tokens")?.textContent).toBe("↑148k ↓1.2k")
  })

  it("draws the tree spine: root is a parent, its last worktree ends the spine", () => {
    render(<AgentsPanel />)
    const root = screen.getByText("session").closest(".diff-file")
    expect(root?.classList.contains("tree-parent")).toBe(true)
    // The single worktree is the last child → elbow only, no through-line.
    const wt = screen.getByText("feat/x").closest(".diff-file")
    expect(wt?.classList.contains("tree-child")).toBe(true)
    expect(wt?.classList.contains("through")).toBe(false)
  })
})

describe("AgentsPanel — nested sub-agents", () => {
  it("indents each level under its parent (OpenCode's custom agents nest)", () => {
    resetStore()
    useStore.setState({
      agents: reduceAgentEvents([
        { event: "SessionStart", sessionId: "s", cwd: "/repo", paneId: "p" },
        { event: "SubagentStart", sessionId: "s", agentId: "a", agentType: "planner" },
        {
          event: "SubagentStart",
          sessionId: "s",
          agentId: "b",
          agentType: "explore",
          parentAgentId: "a",
        },
      ]),
    })
    render(<AgentsPanel />)
    const row = (t: string) => screen.getByText(t).closest(".diff-file") as HTMLElement
    expect(row("planner").style.paddingLeft).toBe("26px")
    expect(row("explore").style.paddingLeft).toBe("42px")
    // Its elbow leaves from its parent's dot, not the root's spine.
    expect(row("planner").style.getPropertyValue("--tree-x")).toBe("13px")
    expect(row("explore").style.getPropertyValue("--tree-x")).toBe("29px")
  })
})
