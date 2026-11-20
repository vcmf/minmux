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
    await waitFor(() => expect(ipc.fsWatch).toHaveBeenLastCalledWith(["/fv3"]))
    view.unmount()
    await waitFor(() => expect(ipc.fsWatch).toHaveBeenLastCalledWith([]))
  })

  it("re-reads a folder the watcher says changed", async () => {
    let onChanged: (dirs: string[]) => void = () => {}
    vi.mocked(ipc.onFsChanged).mockImplementation((cb) => {
      onChanged = cb
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

  it("Parent folder re-roots one level up; Refresh re-reads what's open", async () => {
    vi.mocked(ipc.readdir).mockResolvedValue(ls(["a", false]))
    const { tabId, entryId } = open("/fv7/sub")
    render(<FolderView entryId={entryId} tabId={tabId} />)
    await screen.findByText("a")
    vi.mocked(ipc.readdir).mockClear()
    fireEvent.click(screen.getByTitle("Refresh"))
    await waitFor(() => expect(ipc.readdir).toHaveBeenCalledWith("/fv7/sub", undefined))
    fireEvent.click(screen.getByTitle("Parent folder"))
    expect(st().objects[entryId]!.path).toBe("/fv7")
  })

  it("no Parent folder at the filesystem root", () => {
    vi.mocked(ipc.readdir).mockResolvedValue(ls())
    const { tabId, entryId } = open("/")
    render(<FolderView entryId={entryId} tabId={tabId} />)
    expect(screen.queryByTitle("Parent folder")).toBeNull()
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

  it("clicking a file previews it", async () => {
    vi.mocked(ipc.readdir).mockResolvedValue(ls(["notes.md", false]))
    const { tabId, entryId } = open("/fv9")
    render(<FolderView entryId={entryId} tabId={tabId} />)
    fireEvent.mouseDown(await screen.findByText("notes.md"), { button: 0 })
    expect(st().preview).toEqual({ abs: "/fv9/notes.md", name: "notes.md", wsl: undefined })
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

  it("a folder that can't be read says so", async () => {
    vi.mocked(ipc.readdir).mockResolvedValue({ ...ls(), error: true })
    const { tabId, entryId } = open("/fv11")
    render(<FolderView entryId={entryId} tabId={tabId} />)
    expect(await screen.findByText("Couldn't read this folder")).toBeInTheDocument()
  })
})
