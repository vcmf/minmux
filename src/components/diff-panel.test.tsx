import { describe, it, expect, beforeEach, vi } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
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

describe("DiffPanel — an untracked folder (reported once by git)", () => {
  const withFolder: GitStatus = {
    ...status,
    root: "/repo",
    files: [
      {
        path: "docs/node_modules",
        name: "node_modules",
        dir: "docs",
        status: "?",
        add: 0,
        del: 0,
        isDir: true,
      },
      { path: "src/a.ts", name: "a.ts", dir: "src", status: "M", add: 6, del: 2 },
    ],
  }
  const entries = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      name: `f${String(i).padStart(3, "0")}.js`,
      isDir: false,
    }))

  it("is one row; selection skips it (no diff of its own)", () => {
    st().setGit(withFolder)
    render(<DiffPanel />)
    expect(screen.getByText("node_modules/")).toBeInTheDocument()
    expect(ipc.gitDiff).toHaveBeenCalledWith(expect.anything(), "src/a.ts", undefined)
  })

  it("expands on click into its contents; a big one previews 10 + 'N more · Show all'", async () => {
    st().setGit(withFolder)
    vi.mocked(ipc.readdir).mockResolvedValueOnce({
      entries: entries(150),
      truncated: false,
      total: 150,
    })
    render(<DiffPanel />)
    fireEvent.mouseDown(screen.getByText("node_modules/"), { button: 0 })
    expect(ipc.readdir).toHaveBeenCalledWith("/repo/docs/node_modules", undefined)
    expect(await screen.findByText("140 more")).toBeInTheDocument()
    expect(screen.getAllByText(/^f0\d\d\.js$/)).toHaveLength(10)
    fireEvent.click(screen.getByText("Show all"))
    expect(screen.getAllByText(/^f\d\d\d\.js$/)).toHaveLength(150)
  })

  it("a file inside it can be selected (its diff opens, the selection sticks)", async () => {
    st().setGit(withFolder)
    vi.mocked(ipc.readdir).mockResolvedValueOnce({
      entries: entries(3),
      truncated: false,
      total: 3,
    })
    render(<DiffPanel />)
    fireEvent.mouseDown(screen.getByText("node_modules/"), { button: 0 })
    fireEvent.mouseDown(await screen.findByText("f001.js"), { button: 0 })
    expect(ipc.gitDiff).toHaveBeenLastCalledWith(
      expect.anything(),
      "docs/node_modules/f001.js",
      undefined,
    )
  })

  it("a capped status says how many changes aren't shown", () => {
    st().setGit({ ...status, total: 7000 })
    render(<DiffPanel />)
    expect(screen.getByText("6,998 more changes not shown")).toBeInTheDocument()
    expect(screen.getByText(/7,000 files/)).toBeInTheDocument()
  })
})
