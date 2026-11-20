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
})
