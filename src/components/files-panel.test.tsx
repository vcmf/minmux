import { describe, it, expect, beforeEach, vi } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"
import { FilesPanel } from "./files-panel"
import { useStore } from "../store"
import { ipc } from "../lib/ipc"
import { allSessionIds } from "../lib/pane-tree"
import { resetStore, testHost, testShell } from "../test/helpers"
import { hostShellOption } from "../lib/ssh-hosts-ui"
import type { ShellOption } from "../types"
import { fireEvent } from "@testing-library/react"

const st = () => useStore.getState()
const wslShell: ShellOption = {
  id: "wsl",
  label: "WSL",
  command: "wsl.exe",
  args: ["-d", "Ubuntu"],
}

describe("FilesPanel", () => {
  beforeEach(() => {
    resetStore()
    vi.clearAllMocks()
  })

  it("shows an empty state when the focused pane has no cwd", () => {
    st().newTab(testShell) // session has no cwd yet
    render(<FilesPanel />)
    expect(screen.getByText(/No folder/)).toBeInTheDocument()
  })

  it("lists the root directory returned by readdir", async () => {
    vi.mocked(ipc.readdir).mockResolvedValue({
      entries: [
        { name: "src", isDir: true },
        { name: "README.md", isDir: false },
      ],
      truncated: false,
    })
    st().newTab(testShell)
    const id = allSessionIds(st().tabs[0]!.root)[0]!
    // Unique cwd so the module-level FileTreeCache can't hand back another test's tree.
    st().setSessionCwd(id, "/repo-listtest")
    render(<FilesPanel />)
    await waitFor(() => expect(screen.getByText("src")).toBeInTheDocument())
    expect(screen.getByText("README.md")).toBeInTheDocument()
  })

  it("clicking a file on a WSL pane opens the preview with the pane's WSL context", async () => {
    vi.mocked(ipc.readdir).mockResolvedValue({
      entries: [{ name: "app.ts", isDir: false }],
      truncated: false,
    })
    st().newTab(wslShell)
    const id = allSessionIds(st().tabs[0]!.root)[0]!
    st().setSessionCwd(id, "/home/me/wsltest") // a Linux path
    render(<FilesPanel />)
    const row = await waitFor(() => screen.getByText("app.ts"))
    fireEvent.mouseDown(row, { button: 0 })
    // No longer guarded out on WSL; the distro travels so main reads it via the UNC share.
    expect(st().preview).toMatchObject({
      abs: "/home/me/wsltest/app.ts",
      wsl: { distro: "Ubuntu" },
    })
  })
})

describe("FilesPanel — remote session", () => {
  beforeEach(() => {
    resetStore()
    vi.clearAllMocks()
  })

  it("shows the remote notice and reads nothing locally", () => {
    st().newTab(hostShellOption(testHost("gpu")))
    render(<FilesPanel />)
    expect(screen.getByText(/Remote session on/)).toBeInTheDocument()
    expect(screen.queryByText(/No folder/)).not.toBeInTheDocument()
    expect(ipc.readdir).not.toHaveBeenCalled()
  })

  it("ignores a root override for a remote session", () => {
    st().newTab(hostShellOption(testHost("gpu")))
    const id = st().tabs[0]!.activeSessionId
    useStore.setState({ paneRoot: { [id]: "/Users/me" } })
    render(<FilesPanel />)
    expect(ipc.readdir).not.toHaveBeenCalled()
  })
})

describe("FilesPanel — a big folder", () => {
  beforeEach(() => resetStore())
  it("previews its first 10 entries, then 'N more · Show all · Reveal'", async () => {
    vi.mocked(ipc.readdir).mockResolvedValue({
      entries: Array.from({ length: 150 }, (_, i) => ({
        name: `f${String(i).padStart(3, "0")}`,
        isDir: false,
      })),
      truncated: false,
      total: 150,
    })
    st().newTab(testShell)
    const id = allSessionIds(st().tabs[0]!.root)[0]!
    st().setSessionCwd(id, "/repo-bigfolder")
    const { container } = render(<FilesPanel />)
    await waitFor(() => expect(container.textContent).toContain("140 more"))
    expect(screen.getAllByText(/^f0\d\d$/)).toHaveLength(10)
    fireEvent.click(screen.getByText(/Reveal in|Show in/))
    expect(ipc.revealPath).toHaveBeenCalledWith("/repo-bigfolder")
    fireEvent.click(screen.getByText("Show all"))
    expect(screen.getAllByText(/^f\d\d\d$/)).toHaveLength(150)
  })
})

describe("FilesPanel — staying current", () => {
  beforeEach(() => {
    resetStore()
    vi.clearAllMocks()
  })
  const ls = (...names: [string, boolean][]) => ({
    entries: names.map(([name, isDir]) => ({ name, isDir })),
    truncated: false,
  })
  const open = (cwd: string) => {
    st().newTab(testShell)
    const id = allSessionIds(st().tabs[0]!.root)[0]!
    st().setSessionCwd(id, cwd)
    return render(<FilesPanel />)
  }

  it("re-expanding a folder re-reads it: a file created since shows up", async () => {
    vi.mocked(ipc.readdir).mockImplementation(async (dir: string) =>
      dir.endsWith("/src") ? ls(["a.ts", false]) : ls(["src", true]),
    )
    open("/repo-reexpand")
    await waitFor(() => expect(screen.getByText("src")).toBeInTheDocument())
    fireEvent.mouseDown(screen.getByText("src"), { button: 0 })
    await waitFor(() => expect(screen.getByText("a.ts")).toBeInTheDocument())
    await new Promise((r) => setTimeout(r, 1100)) // past the "read moments ago" skip
    fireEvent.mouseDown(screen.getByText("src"), { button: 0 }) // collapse
    vi.mocked(ipc.readdir).mockImplementation(async (dir: string) =>
      dir.endsWith("/src") ? ls(["a.ts", false], ["b.ts", false]) : ls(["src", true]),
    )
    fireEvent.mouseDown(screen.getByText("src"), { button: 0 }) // expand again
    expect(screen.getByText("a.ts")).toBeInTheDocument() // the cached listing, at once
    await waitFor(() => expect(screen.getByText("b.ts")).toBeInTheDocument())
  })

  it("Refresh re-reads every open folder", async () => {
    vi.mocked(ipc.readdir).mockImplementation(async (dir: string) =>
      dir.endsWith("/lib") ? ls(["x.ts", false]) : ls(["lib", true]),
    )
    open("/repo-refresh")
    await waitFor(() => expect(screen.getByText("lib")).toBeInTheDocument())
    fireEvent.mouseDown(screen.getByText("lib"), { button: 0 })
    await waitFor(() => expect(screen.getByText("x.ts")).toBeInTheDocument())
    vi.mocked(ipc.readdir).mockClear()
    vi.mocked(ipc.readdir).mockImplementation(async (dir: string) =>
      dir.endsWith("/lib")
        ? ls(["x.ts", false], ["y.ts", false])
        : ls(["lib", true], ["new.md", false]),
    )
    fireEvent.click(screen.getByTitle("Refresh"))
    await waitFor(() => expect(screen.getByText("y.ts")).toBeInTheDocument())
    expect(screen.getByText("new.md")).toBeInTheDocument()
    expect(
      vi
        .mocked(ipc.readdir)
        .mock.calls.map((c) => c[0])
        .sort(),
    ).toEqual(["/repo-refresh", "/repo-refresh/lib"])
  })
})

describe("FilesPanel — live refresh", () => {
  beforeEach(() => {
    resetStore()
    vi.clearAllMocks()
  })
  const ls = (...names: [string, boolean][]) => ({
    entries: names.map(([name, isDir]) => ({ name, isDir })),
    truncated: false,
  })

  it("watches the open folders you can see, re-reads one on a change, stops when closed", async () => {
    let onChanged: (dirs: string[]) => void = () => {}
    vi.mocked(ipc.onFsChanged).mockImplementation((cb) => {
      onChanged = cb
      return () => {}
    })
    vi.mocked(ipc.readdir).mockImplementation(async (dir: string) =>
      dir.endsWith("/lib") ? ls(["x.ts", false]) : ls(["lib", true]),
    )
    st().newTab(testShell)
    const id = allSessionIds(st().tabs[0]!.root)[0]!
    st().setSessionCwd(id, "/repo-watch")
    const { unmount } = render(<FilesPanel />)
    await waitFor(() => expect(screen.getByText("lib")).toBeInTheDocument())
    fireEvent.mouseDown(screen.getByText("lib"), { button: 0 })
    await waitFor(() => expect(screen.getByText("x.ts")).toBeInTheDocument())
    await waitFor(() =>
      expect(ipc.fsWatch).toHaveBeenLastCalledWith(["/repo-watch", "/repo-watch/lib"]),
    )
    // An agent writes a file: the watcher reports the folder; no click needed.
    vi.mocked(ipc.readdir).mockImplementation(async (dir: string) =>
      dir.endsWith("/lib") ? ls(["x.ts", false], ["y.ts", false]) : ls(["lib", true]),
    )
    onChanged(["/repo-watch/lib", "/somewhere/else"])
    await waitFor(() => expect(screen.getByText("y.ts")).toBeInTheDocument())
    expect(ipc.readdir).not.toHaveBeenCalledWith("/somewhere/else", undefined)
    unmount()
    expect(ipc.fsWatch).toHaveBeenLastCalledWith([])
  })
})
