import { describe, it, expect, beforeEach, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import { DiffPanel } from "./diff-panel"
import { useStore } from "../store"
import { ipc } from "../lib/ipc"
import { allSessionIds } from "../lib/pane-tree"
import { resetStore, testHost, testShell } from "../test/helpers"
import { hostShellOption } from "../lib/ssh-hosts-ui"
import type { GitStatus } from "../lib/ipc"

const st = () => useStore.getState()

const status: GitStatus = {
  isRepo: true,
  root: "",
  branch: "main",
  ahead: 0,
  behind: 0,
  add: 9,
  del: 2,
  files: [
    { path: "src/a.ts", name: "a.ts", dir: "src", status: "M", add: 6, del: 2 },
    { path: "new.ts", name: "new.ts", dir: ".", status: "?", add: 3, del: 0 },
  ],
}

beforeEach(() => {
  resetStore()
  vi.clearAllMocks()
  st().newTab(testShell)
  const id = allSessionIds(st().tabs[0]!.root)[0]!
  st().setSessionCwd(id, "/repo")
  st().setGit(status)
})

describe("DiffPanel", () => {
  it("renders the summary and changed-file list", () => {
    render(<DiffPanel />)
    expect(screen.getByText("Changes")).toBeInTheDocument()
    expect(screen.getByText("+9")).toBeInTheDocument() // summary total
    expect(screen.getAllByText("−2").length).toBeGreaterThan(0) // summary + a.ts row
    expect(screen.getByText("a.ts")).toBeInTheDocument()
    expect(screen.getByText("new.ts")).toBeInTheDocument()
  })

  it("loads and renders the selected file's diff via ipc", async () => {
    vi.mocked(ipc.gitDiff).mockResolvedValue([
      { type: "hunk", text: "@@ -1 +1 @@" },
      { type: "add", text: "the added line", newNo: 1 },
    ])
    render(<DiffPanel />)
    expect(await screen.findByText("the added line")).toBeInTheDocument()
    expect(ipc.gitDiff).toHaveBeenCalledWith("/repo", "src/a.ts", undefined) // first file auto-selected; no WSL ctx
  })

  it("shows a clean state when the repo has no changes", () => {
    st().setGit({ ...status, files: [], add: 0, del: 0 })
    render(<DiffPanel />)
    expect(screen.getByText(/Working tree clean/i)).toBeInTheDocument()
  })
})

describe("DiffPanel — remote session", () => {
  it("shows the remote notice instead of the (stale) local changes", () => {
    st().newTab(hostShellOption(testHost("gpu")))
    render(<DiffPanel />)
    expect(screen.getByText(/Remote session on/)).toBeInTheDocument()
    expect(screen.getByText("gpu")).toBeInTheDocument()
    expect(screen.queryByText("a.ts")).not.toBeInTheDocument()
    expect(screen.queryByText("+9")).not.toBeInTheDocument()
    expect(ipc.gitDiff).not.toHaveBeenCalled()
  })
})
