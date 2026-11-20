import { describe, it, expect, beforeEach, vi } from "vitest"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { FileView } from "./file-view"
import { useStore } from "../store"
import { ipc } from "../lib/ipc"
import { resetStore, testShell } from "../test/helpers"

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
    let onChanged: (dirs: string[]) => void = () => {}
    vi.mocked(ipc.onFsChanged).mockImplementation((cb) => {
      onChanged = cb
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
    await waitFor(() => expect(ipc.fsWatch).toHaveBeenLastCalledWith(["/w"]))
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
})
