import { describe, it, expect, beforeEach, vi } from "vitest"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { FolderView } from "./folder-view"
import { useStore } from "../store"
import { ipc } from "../lib/ipc"
import { resetStore, testShell } from "../test/helpers"

const st = () => useStore.getState()
const ls = (...names: [string, boolean][]) => ({
  entries: names.map(([name, isDir]) => ({ name, isDir })),
  truncated: false,
})

// Listings are shared by path across tests (one store per renderer): each test its own folder.
const open = (path: string) => {
  st().newTab(testShell)
  st().openFolder(path)
  const tab = st().tabs[0]!
  return { tabId: tab.id, entryId: tab.activeEntryId }
}

beforeEach(() => {
  resetStore()
  vi.clearAllMocks()
})

describe("FolderView", () => {
  it("lists its folder and expands a subfolder, remembering it in the store", async () => {
    vi.mocked(ipc.readdir).mockImplementation(async (dir: string) =>
      dir.endsWith("/src") ? ls(["main.ts", false]) : ls(["src", true], ["README.md", false]),
    )
    const { tabId, entryId } = open("/fv1")
    render(<FolderView entryId={entryId} tabId={tabId} />)
    fireEvent.mouseDown(await screen.findByText("src"), { button: 0 })
    expect(await screen.findByText("main.ts")).toBeInTheDocument()
    expect(st().folderViews[entryId]!.expanded).toEqual(["/fv1/src"])
  })

  it("double-clicking a subfolder makes it the tab's folder", async () => {
    vi.mocked(ipc.readdir).mockResolvedValue(ls(["docs", true]))
    const { tabId, entryId } = open("/fv2")
    render(<FolderView entryId={entryId} tabId={tabId} />)
    fireEvent.doubleClick(await screen.findByText("docs"))
    expect(st().objects[entryId]!.path).toBe("/fv2/docs")
  })

  it("watches its open folders while shown, and lets go when it hides", async () => {
    vi.mocked(ipc.readdir).mockResolvedValue(ls(["a", false]))
    const { tabId, entryId } = open("/fv3")
    const view = render(<FolderView entryId={entryId} tabId={tabId} />)
    await waitFor(() => expect(ipc.fsWatch).toHaveBeenLastCalledWith(["/fv3"], expect.any(Array)))
    view.unmount()
    await waitFor(() => expect(ipc.fsWatch).toHaveBeenLastCalledWith([], expect.any(Array)))
  })

  it("re-reads a folder the watcher says changed", async () => {
    let onChanged: (dirs: string[], content?: string[]) => void = () => {}
    vi.mocked(ipc.onFsChanged).mockImplementation((cb) => {
      onChanged = (d, c = []) => cb(d, c)
      return () => {}
    })
    vi.mocked(ipc.readdir).mockResolvedValue(ls(["old.txt", false]))
    const { tabId, entryId } = open("/fv4")
    render(<FolderView entryId={entryId} tabId={tabId} />)
    expect(await screen.findByText("old.txt")).toBeInTheDocument()
    vi.mocked(ipc.readdir).mockResolvedValue(ls(["new.txt", false], ["old.txt", false]))
    onChanged(["/fv4"])
    expect(await screen.findByText("new.txt")).toBeInTheDocument()
  })

  it("New terminal here opens a terminal in this folder, as a tab of the same pane", async () => {
    vi.mocked(ipc.readdir).mockResolvedValue(ls())
    const { tabId, entryId } = open("/fv5")
    render(<FolderView entryId={entryId} tabId={tabId} />)
    fireEvent.click(screen.getByTitle("New terminal here"))
    const tab = st().tabs[0]!
    expect(st().sessions[tab.activeEntryId]!.cwd).toBe("/fv5")
    expect(tab.root).toMatchObject({ type: "leaf" }) // same pane, no split
  })

  it("a big folder previews its first entries, then shows all on request", async () => {
    const many = Array.from(
      { length: 120 },
      (_, i) => [`f${String(i).padStart(3, "0")}`, false] as [string, boolean],
    )
    vi.mocked(ipc.readdir).mockResolvedValue({ ...ls(...many), total: 120 })
    const { tabId, entryId } = open("/fv6")
    render(<FolderView entryId={entryId} tabId={tabId} />)
    expect(await screen.findByText("110 more")).toBeInTheDocument()
    expect(screen.queryByText("f119")).toBeNull()
    fireEvent.click(screen.getByText("Show all"))
    expect(await screen.findByText("f119")).toBeInTheDocument()
    expect(st().folderViews[entryId]!.showAll).toEqual(["/fv6"])
  })

  it("a breadcrumb segment re-roots there; Refresh re-reads what's open", async () => {
    vi.mocked(ipc.readdir).mockResolvedValue(ls(["a", false]))
    const { tabId, entryId } = open("/fv7/sub")
    render(<FolderView entryId={entryId} tabId={tabId} />)
    await screen.findByText("a")
    vi.mocked(ipc.readdir).mockClear()
    fireEvent.click(screen.getByTitle("Refresh"))
    await waitFor(() => expect(ipc.readdir).toHaveBeenCalledWith("/fv7/sub", undefined))
    fireEvent.click(screen.getByText("fv7")) // its breadcrumb's parent segment
    expect(st().objects[entryId]!.path).toBe("/fv7")
  })

  it("a typed path in its breadcrumb re-roots it, once it's a folder", async () => {
    vi.mocked(ipc.readdir).mockResolvedValue(ls())
    vi.mocked(ipc.pathIsDir).mockResolvedValue(true)
    const { tabId, entryId } = open("/fv12")
    render(<FolderView entryId={entryId} tabId={tabId} />)
    fireEvent.click(screen.getByTitle("Enter a path"))
    const input = screen.getByPlaceholderText(/folder path/i)
    fireEvent.change(input, { target: { value: "/fv12-other" } })
    fireEvent.keyDown(input, { key: "Enter" })
    await waitFor(() => expect(st().objects[entryId]!.path).toBe("/fv12-other"))
  })

  it("back to the window: re-reads the open folders no watcher covers", async () => {
    vi.mocked(ipc.readdir).mockResolvedValue(ls(["a", false]))
    vi.mocked(ipc.fsWatching).mockResolvedValue([])
    const { tabId, entryId } = open("/fv8")
    render(<FolderView entryId={entryId} tabId={tabId} />)
    await screen.findByText("a")
    vi.mocked(ipc.readdir).mockClear()
    window.dispatchEvent(new Event("focus"))
    await waitFor(() => expect(ipc.readdir).toHaveBeenCalledWith("/fv8", undefined))
  })

  it("clicking a file opens it as a peek tab of this pane; ⌘-click keeps it", async () => {
    vi.mocked(ipc.readdir).mockResolvedValue(ls(["notes.md", false], ["b.ts", false]))
    useStore.setState({ platform: "darwin" }) // ⌘ keeps on a Mac (Ctrl elsewhere)
    const { tabId, entryId } = open("/fv9")
    render(<FolderView entryId={entryId} tabId={tabId} />)
    fireEvent.click(await screen.findByText("notes.md"), { button: 0 })
    const peek = st().tabs[0]!.activeEntryId
    expect(st().objects[peek]).toEqual({ kind: "file", path: "/fv9/notes.md", peek: true })
    fireEvent.click(screen.getByText("b.ts"), { button: 0, metaKey: true })
    const kept = st().tabs[0]!.activeEntryId
    expect(st().objects[kept]).toEqual({ kind: "file", path: "/fv9/b.ts" })
  })

  it("a PDF opens in its own app, not a tab", async () => {
    vi.mocked(ipc.readdir).mockResolvedValue(ls(["r.pdf", false]))
    const { tabId, entryId } = open("/fv13")
    render(<FolderView entryId={entryId} tabId={tabId} />)
    fireEvent.click(await screen.findByText("r.pdf"), { button: 0 })
    expect(ipc.openPath).toHaveBeenCalledWith("/fv13/r.pdf", undefined)
    expect(st().tabs[0]!.activeEntryId).toBe(entryId)
  })

  it("its right-click menu's Set as root re-roots this tab", async () => {
    vi.mocked(ipc.readdir).mockResolvedValue(ls(["lib", true]))
    vi.mocked(ipc.editorInfo).mockResolvedValue({ available: false, name: "" })
    useStore.setState({ platform: "darwin" })
    const { tabId, entryId } = open("/fv10")
    render(<FolderView entryId={entryId} tabId={tabId} />)
    fireEvent.contextMenu(await screen.findByText("lib"))
    fireEvent.mouseDown(screen.getByText(/root/i), { button: 0 })
    expect(st().objects[entryId]!.path).toBe("/fv10/lib")
  })

  it("its right-click menu previews a file; a WSL folder opens no menu", async () => {
    vi.mocked(ipc.readdir).mockResolvedValue(ls(["n.md", false]))
    vi.mocked(ipc.editorInfo).mockResolvedValue({ available: false, name: "" })
    useStore.setState({ platform: "darwin" })
    const { tabId, entryId } = open("/fv12")
    const v = render(<FolderView entryId={entryId} tabId={tabId} />)
    fireEvent.contextMenu(await screen.findByText("n.md"))
    fireEvent.mouseDown(screen.getByText("Preview"), { button: 0 })
    expect(st().preview).toEqual({ abs: "/fv12/n.md", name: "n.md" })
    v.unmount()
    st().newTab(testShell)
    st().openFolder("/home/u/w", { wsl: { distro: "Ubuntu" } })
    const t = st().tabs[1]!
    render(<FolderView entryId={t.activeEntryId} tabId={t.id} />)
    fireEvent.contextMenu(await screen.findAllByText("n.md").then((x) => x[x.length - 1]!))
    expect(screen.queryByText("Preview")).toBeNull()
  })

  it("a folder that can't be read says so", async () => {
    vi.mocked(ipc.readdir).mockResolvedValue({ ...ls(), error: true })
    const { tabId, entryId } = open("/fv11")
    render(<FolderView entryId={entryId} tabId={tabId} />)
    expect(await screen.findByText("Couldn't read this folder")).toBeInTheDocument()
  })

  it("shows git marks for a folder in another repo, from the folder entries' own poll", async () => {
    vi.mocked(ipc.readdir).mockResolvedValue(ls(["app.ts", false]))
    vi.mocked(ipc.gitStatus).mockResolvedValue({
      isRepo: true,
      root: "/fvg",
      branch: "main",
      ahead: 0,
      behind: 0,
      files: [{ path: "app.ts", status: "M" }],
      add: 1,
      del: 0,
    } as never)
    vi.mocked(ipc.gitRoots).mockResolvedValue({ "/fvg": "/fvg" }) // its own .git search
    const { tabId, entryId } = open("/fvg")
    const view = render(<FolderView entryId={entryId} tabId={tabId} />)
    await waitFor(() => expect(screen.getByText("M")).toBeInTheDocument())
    expect(ipc.gitStatus).toHaveBeenCalledWith("/fvg", undefined)
    view.unmount()
  })

  it("shows its repo in the bar, counts changes in folders, and lists only the changes", async () => {
    vi.mocked(ipc.readdir).mockImplementation(async (dir: string) =>
      dir === "/fvc" ? ls(["src", true], ["top.ts", false]) : ls(["a.ts", false]),
    )
    vi.mocked(ipc.gitStatus).mockResolvedValue({
      isRepo: true,
      root: "/fvc",
      branch: "feat/x",
      ahead: 2,
      behind: 0,
      files: [
        { path: "src/a.ts", dir: "src", status: "M", add: 3, del: 1 },
        { path: "gone.ts", dir: "", status: "D", add: 0, del: 4 },
        { path: "tmp/", dir: "", status: "?", add: 0, del: 0, isDir: true },
        { path: "spec.pdf", dir: "", status: "D", add: 0, del: 0 },
        { path: "deck.pdf", dir: "", status: "M", add: 0, del: 0 },
      ],
      add: 3,
      del: 5,
    } as never)
    vi.mocked(ipc.gitRoots).mockResolvedValue({ "/fvc": "/fvc" })
    const { tabId, entryId } = open("/fvc")
    const view = render(<FolderView entryId={entryId} tabId={tabId} />)
    await waitFor(() => expect(screen.getByText("feat/x")).toBeInTheDocument())
    expect(screen.getByText("↑2")).toBeInTheDocument()
    expect(screen.queryByText(/↓/)).toBeNull()
    expect(await screen.findByTitle("1 change inside")).toHaveTextContent("1") // src/

    // The +/− pill: the changed files under it, flat, with their counts.
    fireEvent.click(screen.getByTitle("Show only the 5 changed files"))
    expect(st().folderViews[entryId]?.changesOnly).toBe(true)
    expect(screen.queryByText("top.ts")).toBeNull()
    expect(screen.getByText("a.ts")).toBeInTheDocument()
    expect(screen.getByText("src/")).toBeInTheDocument() // its folder, after its name
    expect(screen.getByText("−4")).toBeInTheDocument()

    // A modified file opens on its diff (a peek); a deleted one too.
    fireEvent.click(screen.getByText("a.ts"), { button: 0 })
    const peek = st().tabs[0]!.activeEntryId
    expect(st().objects[peek]).toEqual({
      kind: "file",
      path: "/fvc/src/a.ts",
      peek: true,
      view: "diff",
    })
    // A deleted PDF opens on its diff, never in the OS's app (it's gone).
    fireEvent.click(screen.getByText("spec.pdf"), { button: 0 })
    expect(ipc.openPath).not.toHaveBeenCalled()
    expect(st().objects[st().tabs[0]!.activeEntryId]).toMatchObject({
      path: "/fvc/spec.pdf",
      view: "diff",
    })
    // A modified PDF opens in its own app, as from the tree.
    fireEvent.click(screen.getByText("deck.pdf"), { button: 0 })
    expect(ipc.openPath).toHaveBeenCalledWith("/fvc/deck.pdf", undefined)
    // A new folder opens as a folder tab.
    fireEvent.click(screen.getByText("tmp/"), { button: 0 })
    const dir = st().tabs[0]!.activeEntryId
    expect(st().objects[dir]).toMatchObject({ kind: "folder", path: "/fvc/tmp" })

    // Back to the tree.
    fireEvent.click(screen.getByTitle("Show the folder"))
    expect(st().folderViews[entryId]?.changesOnly).toBeUndefined()
    expect(await screen.findByText("top.ts")).toBeInTheDocument()
    view.unmount()
  })

  it("a repo with more changes than its status lists says how many aren't shown", async () => {
    vi.mocked(ipc.readdir).mockResolvedValue(ls(["a.ts", false]))
    vi.mocked(ipc.gitStatus).mockResolvedValue({
      isRepo: true,
      root: "/fvt",
      branch: "main",
      ahead: 0,
      behind: 0,
      files: [{ path: "a.ts", dir: "", status: "M", add: 1, del: 0 }],
      add: 1,
      del: 0,
      total: 5001,
    } as never)
    vi.mocked(ipc.gitRoots).mockResolvedValue({ "/fvt": "/fvt" })
    const { tabId, entryId } = open("/fvt")
    st().setFolderView(entryId, { expanded: [], showAll: [], changesOnly: true })
    render(<FolderView entryId={entryId} tabId={tabId} />)
    expect(
      await screen.findByText(/5000 more changes in this repo, not listed/),
    ).toBeInTheDocument()
    expect(screen.getByTitle("Show the folder")).toBeInTheDocument()
  })

  it("one unlisted change is counted in the pill and the list", async () => {
    vi.mocked(ipc.readdir).mockResolvedValue(ls(["a.ts", false]))
    vi.mocked(ipc.gitStatus).mockResolvedValue({
      isRepo: true,
      root: "/fvu",
      branch: "main",
      ahead: 0,
      behind: 0,
      files: [{ path: "a.ts", dir: "", status: "M", add: 1, del: 0 }],
      add: 1,
      del: 0,
      total: 2,
    } as never)
    vi.mocked(ipc.gitRoots).mockResolvedValue({ "/fvu": "/fvu" })
    const { tabId, entryId } = open("/fvu")
    render(<FolderView entryId={entryId} tabId={tabId} />)
    fireEvent.click(await screen.findByTitle("Show only the 1+ changed files"))
    expect(screen.getByText(/1 more change in this repo, not listed/)).toBeInTheDocument()
  })

  it("a folder in no repo has no repo bar and stays a tree", async () => {
    vi.mocked(ipc.readdir).mockResolvedValue(ls(["x.ts", false]))
    vi.mocked(ipc.gitRoots).mockResolvedValue({})
    const { tabId, entryId } = open("/fvn")
    st().setFolderView(entryId, { expanded: [], showAll: [], changesOnly: true })
    render(<FolderView entryId={entryId} tabId={tabId} />)
    expect(await screen.findByText("x.ts")).toBeInTheDocument()
    expect(screen.queryByTitle(/changed file/)).toBeNull()
  })

  it("a long tree renders only the rows around the view", async () => {
    const many = Array.from(
      { length: 480 },
      (_, i) => [`n${String(i).padStart(3, "0")}`, false] as [string, boolean],
    )
    vi.mocked(ipc.readdir).mockResolvedValue({ ...ls(...many), total: 480 })
    const { tabId, entryId } = open("/fvv")
    const { container } = render(<FolderView entryId={entryId} tabId={tabId} />)
    fireEvent.click(await screen.findByText("Show all"))
    await screen.findByText("n000")
    expect(container.querySelectorAll(".file-row").length).toBeLessThan(60)
    expect(screen.queryByText("n479")).toBeNull() // far below: a spacer stands for it
  })

  it("on a Mac, Ctrl-click (a right-click) opens no tab", async () => {
    vi.mocked(ipc.readdir).mockResolvedValue(ls(["c.ts", false]))
    useStore.setState({ platform: "darwin" })
    const { tabId, entryId } = open("/fv14")
    render(<FolderView entryId={entryId} tabId={tabId} />)
    fireEvent.click(await screen.findByText("c.ts"), { button: 0, ctrlKey: true })
    expect(st().tabs[0]!.activeEntryId).toBe(entryId)
  })
})
