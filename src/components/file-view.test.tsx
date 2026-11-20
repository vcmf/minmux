import { describe, it, expect, beforeEach, vi } from "vitest"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { FileView } from "./file-view"
import { useStore } from "../store"
import { ipc } from "../lib/ipc"
import { resetStore, testShell } from "../test/helpers"
import { wantKey } from "../lib/folder-git"

const st = () => useStore.getState()
const open = (path: string, line?: number) => {
  st().newTab(testShell)
  st().openFile(path, { line })
  const tab = st().tabs[0]!
  return { tabId: tab.id, entryId: tab.activeEntryId }
}

beforeEach(() => {
  resetStore()
  vi.clearAllMocks()
})

describe("FileView", () => {
  it("shows the file's lines with their numbers, highlighted", async () => {
    vi.mocked(ipc.readFile).mockResolvedValue({
      kind: "text",
      text: "const a = 1\nlet b = 2\n",
      truncated: false,
      size: 22,
    })
    const { tabId, entryId } = open("/w/x.ts")
    const { container } = render(<FileView entryId={entryId} tabId={tabId} />)
    await waitFor(() => expect(container.querySelector(".hljs-keyword")).not.toBeNull())
    expect(container.querySelectorAll(".file-view-line").length).toBeGreaterThan(0)
    expect(container.querySelector(".file-view-no")!.textContent).toBe("1")
    expect(ipc.readFile).toHaveBeenCalledWith("/w/x.ts", undefined, undefined) // no stamp: a first read
  })

  it("marks the line it was opened at", async () => {
    vi.mocked(ipc.readFile).mockResolvedValue({
      kind: "text",
      text: "a\nb\nc\n",
      truncated: false,
      size: 6,
    })
    const { tabId, entryId } = open("/w/notes.txt", 2)
    const { container } = render(<FileView entryId={entryId} tabId={tabId} />)
    await waitFor(() => expect(container.querySelector(".file-view-line.target")).not.toBeNull())
    expect(container.querySelector(".file-view-line.target")!.textContent).toBe("2b")
  })

  it("an image shows as a picture; a binary or a huge file offers to open it outside", async () => {
    vi.mocked(ipc.readFile).mockResolvedValueOnce({
      kind: "image",
      dataUrl: "data:image/png;base64,AA==",
      size: 1,
    })
    const a = open("/w/p.png")
    const v = render(<FileView entryId={a.entryId} tabId={a.tabId} />)
    expect(await screen.findByAltText("/w/p.png")).toBeInTheDocument()
    v.unmount()
    resetStore()
    vi.mocked(ipc.readFile).mockResolvedValueOnce({ kind: "too-large", size: 9_000_000 })
    const b = open("/w/big.log")
    render(<FileView entryId={b.entryId} tabId={b.tabId} />)
    fireEvent.click(await screen.findByText("Open it outside minmux"))
    expect(ipc.openFile).toHaveBeenCalledWith("", "/w/big.log", undefined)
  })

  it("re-reads when its folder's watcher says something changed (an agent writing it)", async () => {
    let onChanged: (dirs: string[], content?: string[]) => void = () => {}
    vi.mocked(ipc.onFsChanged).mockImplementation((cb) => {
      onChanged = (d, c = []) => cb(d, c)
      return () => {}
    })
    vi.mocked(ipc.readFile).mockResolvedValue({
      kind: "text",
      text: "v1",
      truncated: false,
      size: 2,
    })
    useStore.setState({ platform: "darwin" })
    const { tabId, entryId } = open("/w/live.txt")
    render(<FileView entryId={entryId} tabId={tabId} />)
    expect(await screen.findByText("v1")).toBeInTheDocument()
    await waitFor(() => expect(ipc.fsWatch).toHaveBeenLastCalledWith(["/w"], expect.any(Array)))
    vi.mocked(ipc.readFile).mockResolvedValue({
      kind: "text",
      text: "v2",
      truncated: false,
      size: 2,
    })
    onChanged(["/w"])
    expect(await screen.findByText("v2")).toBeInTheDocument()
  })

  it("Open its folder adds the file's folder as a tab of its pane", async () => {
    vi.mocked(ipc.readFile).mockResolvedValue({ kind: "text", text: "", truncated: false, size: 0 })
    const { tabId, entryId } = open("/w/rts/a.ts")
    render(<FileView entryId={entryId} tabId={tabId} />)
    fireEvent.click(screen.getByTitle("Open its folder"))
    const tab = st().tabs[0]!
    expect(st().objects[tab.activeEntryId]).toEqual({ kind: "folder", path: "/w/rts" })
  })

  it("a re-read that finds the file unchanged keeps it highlighted", async () => {
    let onChanged: (dirs: string[], content?: string[]) => void = () => {}
    vi.mocked(ipc.onFsChanged).mockImplementation((cb) => {
      onChanged = (d, c = []) => cb(d, c)
      return () => {}
    })
    useStore.setState({ platform: "darwin" })
    vi.mocked(ipc.readFile).mockResolvedValueOnce({
      kind: "text",
      text: "const v = 2",
      truncated: false,
      size: 11,
      stamp: { size: 11, mtimeMs: 1 },
    })
    vi.mocked(ipc.readFile).mockResolvedValue({ kind: "same" })
    const { tabId, entryId } = open("/w/s.ts")
    const { container } = render(<FileView entryId={entryId} tabId={tabId} />)
    await waitFor(() => expect(container.querySelector(".hljs-keyword")).not.toBeNull())
    onChanged(["/w"]) // something else in its folder changed
    await waitFor(() => expect(ipc.readFile).toHaveBeenCalledTimes(2))
    expect(vi.mocked(ipc.readFile).mock.calls[1]![2]).toEqual({ size: 11, mtimeMs: 1 })
    expect(container.querySelector(".hljs-keyword")).not.toBeNull()
  })

  // The focused terminal's repo is /gr: its status says which files changed.
  const inRepo = (files: { path: string; status: string; add: number; del: number }[]) => {
    const roots = { [wantKey({ path: "/gr/src" })]: "/gr" }
    vi.mocked(ipc.gitRoots).mockResolvedValue({ "/gr/src": "/gr" }) // the poll's own lookup
    useStore.setState({
      folderRoots: roots,
      git: {
        isRepo: true,
        root: "/gr",
        branch: "main",
        ahead: 0,
        behind: 0,
        files: files.map((f) => ({ ...f, dir: "src" })),
        add: 0,
        del: 0,
      } as never,
    })
  }
  const diff = [
    { type: "hunk" as const, text: "@@ -1,2 +1,2 @@" },
    { type: "context" as const, text: "const a = 1", oldNo: 1, newNo: 1 },
    { type: "del" as const, text: "let b = 2", oldNo: 2 },
    { type: "add" as const, text: "let b = 3", newNo: 2 },
  ]

  it("a modified file shows change bars on Source, and its diff on Diff", async () => {
    vi.mocked(ipc.readFile).mockResolvedValue({
      kind: "text",
      text: "const a = 1\nlet b = 3\n",
      truncated: false,
      size: 22,
    })
    vi.mocked(ipc.gitDiff).mockResolvedValue(diff)
    inRepo([{ path: "src/m.ts", status: "M", add: 1, del: 1 }])
    const { tabId, entryId } = open("/gr/src/m.ts")
    const { container } = render(<FileView entryId={entryId} tabId={tabId} />)
    await waitFor(() => expect(container.querySelector(".file-view-bar.mod")).not.toBeNull())
    expect(ipc.gitDiff).toHaveBeenCalledWith("/gr", "src/m.ts", undefined)
    expect(screen.getByText("Source")).toHaveClass("on")
    fireEvent.click(screen.getByText("Diff"))
    expect(st().objects[entryId]).toMatchObject({ view: "diff" })
    await waitFor(() => expect(container.querySelector(".diff-line.del")).not.toBeNull())
    const del = container.querySelector(".diff-line.del")!
    expect(del.querySelector(".diff-sign")!.textContent).toBe("−")
    expect(del.textContent).toContain("2") // its old line number
    expect(container.querySelector(".diff-line.add .diff-sign")!.textContent).toBe("+")
    fireEvent.click(screen.getByText("Source"))
    await waitFor(() => expect(container.querySelector(".diff-line")).toBeNull())
  })

  it("a deleted file shows its diff, with no toggle; a new one has neither", async () => {
    vi.mocked(ipc.readFile).mockResolvedValue({ kind: "error", message: "No such file" })
    vi.mocked(ipc.gitDiff).mockResolvedValue([diff[0]!, diff[2]!])
    inRepo([
      { path: "src/gone.ts", status: "D", add: 0, del: 1 },
      { path: "src/new.ts", status: "?", add: 0, del: 0 },
    ])
    const a = open("/gr/src/gone.ts")
    const v = render(<FileView entryId={a.entryId} tabId={a.tabId} />)
    await waitFor(() => expect(v.container.querySelector(".diff-line.del")).not.toBeNull())
    expect(screen.queryByText("Diff")).toBeNull()
    expect(screen.queryByText("No such file")).toBeNull()
    v.unmount()
    vi.mocked(ipc.gitDiff).mockClear()
    vi.mocked(ipc.readFile).mockResolvedValue({
      kind: "text",
      text: "x\n",
      truncated: false,
      size: 2,
    })
    const b = open("/gr/src/new.ts")
    const w = render(<FileView entryId={b.entryId} tabId={b.tabId} />)
    await waitFor(() => expect(w.container.querySelector(".file-view-line")).not.toBeNull())
    expect(ipc.gitDiff).not.toHaveBeenCalled()
    expect(screen.queryByText("Diff")).toBeNull()
  })
})
