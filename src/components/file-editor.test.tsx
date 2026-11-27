import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { act, render, screen, fireEvent, waitFor } from "@testing-library/react"
import { EditorView } from "@codemirror/view"
import FileEditor from "./file-editor"
import { useStore } from "../store"
import { ipc } from "../lib/ipc"
import { edits } from "../lib/edit-store"
import { resetStore, testShell } from "../test/helpers"
import type { FileData, SaveResult } from "../lib/file-tab"

// jsdom has no layout: CodeMirror measures text ranges, which it lacks.
const proto = Range.prototype as unknown as Record<string, unknown>
proto.getClientRects ??= () => []
proto.getBoundingClientRect ??= () => new DOMRect()

const st = () => useStore.getState()
const stamp = { size: 1, mtimeMs: 1 }
const saved = (hash = "h1"): SaveResult => ({ kind: "saved", stamp, hash })
const text = (t: string, hash: string): FileData => ({
  kind: "text",
  text: t,
  truncated: false,
  size: t.length,
  stamp,
  hash,
  editable: true,
})

let entryId = ""
let tabId = ""
const onDone = vi.fn()
const view = () => EditorView.findFromDOM(document.querySelector(".cm-content") as HTMLElement)!
const doc = () => view().state.doc.toString()
const type = (insert: string, at = view().state.doc.length) =>
  act(() => view().dispatch({ changes: { from: at, insert } }))

async function mount(raw: string, path = "/w/a.ts", hash = "h0") {
  st().newTab(testShell)
  st().openFile(path)
  const tab = st().tabs[0]!
  tabId = tab.id
  entryId = tab.activeEntryId
  edits.start(entryId, path, undefined, raw, hash)
  const r = render(<FileEditor entryId={entryId} tabId={tabId} path={path} onDone={onDone} />)
  await waitFor(() => expect(document.querySelector(".cm-content")).not.toBeNull())
  return r
}

beforeEach(() => {
  resetStore()
  vi.clearAllMocks()
})
afterEach(() => {
  for (const id of [entryId]) edits.stop(id)
})

describe("FileEditor", () => {
  it("shows the file, marks unsaved text, and saves it cleaned up", async () => {
    vi.mocked(ipc.writeFile).mockResolvedValue(saved())
    await mount("a = 1\n")
    expect(doc()).toBe("a = 1\n")
    expect(screen.getByText("Save").closest("button")!.disabled).toBe(true)
    type("b = 2   \n\n\n")
    await waitFor(() => expect(document.querySelector(".file-editor-dot")).not.toBeNull())
    act(() => view().dispatch({ selection: { anchor: 0 } })) // the cursor off the edited lines
    fireEvent.click(screen.getByText("Save"))
    await waitFor(() => expect(ipc.writeFile).toHaveBeenCalled())
    expect(vi.mocked(ipc.writeFile).mock.calls[0]!.slice(0, 3)).toEqual([
      "/w/a.ts",
      "a = 1\nb = 2\n",
      "h0",
    ])
    await waitFor(() => expect(document.querySelector(".file-editor-dot")).toBeNull())
    expect(doc()).toBe("a = 1\nb = 2\n") // the cleanup is in the editor too (undoable)
  })

  it("Cmd-S on a clean file writes nothing", async () => {
    await mount("x\n")
    fireEvent.keyDown(document.querySelector(".cm-content")!, {
      key: "s",
      metaKey: true,
      ctrlKey: true,
    })
    await new Promise((r) => setTimeout(r, 20))
    expect(ipc.writeFile).not.toHaveBeenCalled()
  })

  it("a change on disk: overwrite with mine, or reload theirs", async () => {
    vi.mocked(ipc.writeFile).mockResolvedValueOnce({ kind: "changed" })
    await mount("a\n")
    type("b\n")
    fireEvent.click(screen.getByText("Save"))
    await screen.findByText("The file changed on disk since you opened it.")
    vi.mocked(ipc.readFile).mockResolvedValue(text("theirs\n", "hT"))
    vi.mocked(ipc.writeFile).mockResolvedValueOnce(saved("h2"))
    fireEvent.click(screen.getByText("Overwrite with mine"))
    await waitFor(() => expect(ipc.writeFile).toHaveBeenCalledTimes(2))
    expect(vi.mocked(ipc.writeFile).mock.calls[1]![2]).toBe("hT") // over what's there now
    await waitFor(() => expect(screen.queryByText(/changed on disk/)).toBeNull())
  })

  it("reload theirs replaces the text and clears unsaved", async () => {
    vi.mocked(ipc.writeFile).mockResolvedValueOnce({ kind: "changed" })
    await mount("a\n")
    type("mine\n")
    fireEvent.click(screen.getByText("Save"))
    await screen.findByText(/changed on disk/)
    vi.mocked(ipc.readFile).mockResolvedValue(text("theirs\n", "hT"))
    fireEvent.click(screen.getByText("Reload theirs (drop mine)"))
    await waitFor(() => expect(doc()).toBe("theirs\n"))
    await waitFor(() => expect(document.querySelector(".file-editor-dot")).toBeNull())
  })

  it("a deleted file can be saved back", async () => {
    vi.mocked(ipc.writeFile).mockResolvedValueOnce({ kind: "missing" })
    await mount("a\n")
    type("b\n")
    fireEvent.click(screen.getByText("Save"))
    await screen.findByText("The file was deleted.")
    vi.mocked(ipc.writeFile).mockResolvedValueOnce(saved())
    fireEvent.click(screen.getByText("Save it back"))
    await waitFor(() => expect(vi.mocked(ipc.writeFile).mock.calls[1]![4]).toBe(true))
  })

  it("an unsure save says so; save again overwrites", async () => {
    vi.mocked(ipc.writeFile).mockResolvedValueOnce({ kind: "unknown" })
    vi.mocked(ipc.readFile).mockResolvedValue(text("a\n", "h0")) // it didn't land
    await mount("a\n")
    type("b\n")
    fireEvent.click(screen.getByText("Save"))
    await screen.findByText(/may not have finished/)
    vi.mocked(ipc.writeFile).mockResolvedValueOnce(saved())
    fireEvent.click(screen.getByText("Save again"))
    await waitFor(() => expect(screen.queryByText(/may not have finished/)).toBeNull())
  })

  it("an error shows, and can be dismissed", async () => {
    vi.mocked(ipc.writeFile).mockResolvedValueOnce({ kind: "error", message: "EACCES" })
    await mount("a\n")
    type("b\n")
    fireEvent.click(screen.getByText("Save"))
    await screen.findByText("Couldn't save: EACCES")
    fireEvent.click(screen.getByTitle("Dismiss"))
    expect(screen.queryByText(/EACCES/)).toBeNull()
  })

  it("Done with unsaved text asks; Cancel stays, Discard leaves", async () => {
    await mount("a\n")
    type("b\n")
    fireEvent.click(screen.getByText("Done"))
    expect(screen.getByText("Save your changes before leaving Edit?")).toBeTruthy()
    fireEvent.click(screen.getByText("Cancel"))
    expect(screen.queryByText(/Save your changes/)).toBeNull()
    fireEvent.click(screen.getByText("Done"))
    fireEvent.click(screen.getByText("Discard"))
    expect(onDone).toHaveBeenCalledWith(1)
    expect(edits.get(entryId)).toBeUndefined()
  })

  it("Done, then Save: saves and leaves", async () => {
    vi.mocked(ipc.writeFile).mockResolvedValue(saved())
    await mount("a\n")
    type("b\n")
    fireEvent.click(screen.getByText("Done"))
    fireEvent.click(screen.getAllByText("Save")[1]!) // the bar's
    await waitFor(() => expect(onDone).toHaveBeenCalled())
  })

  it("a same-length edit typed just before Done still asks", async () => {
    await mount("a\n")
    act(() => view().dispatch({ changes: { from: 0, to: 1, insert: "z" } }))
    fireEvent.click(screen.getByText("Done"))
    expect(screen.getByText("Save your changes before leaving Edit?")).toBeTruthy()
  })

  it("a path click on the file moves the cursor to its line", async () => {
    await mount("one\ntwo\nthree\n")
    act(() => st().openFile("/w/a.ts", { line: 3 }))
    await waitFor(() =>
      expect(view().state.doc.lineAt(view().state.selection.main.head).number).toBe(3),
    )
  })

  it("asking for its Diff leaves a clean edit", async () => {
    await mount("a\n")
    act(() => st().setFileView(entryId, "diff"))
    await waitFor(() => expect(onDone).toHaveBeenCalled())
  })

  it("mixed line endings are pointed out", async () => {
    await mount("a\r\nb\n")
    expect(screen.getByText(/Mixed line endings/)).toBeTruthy()
  })

  it("a remount keeps the text and its unsaved mark", async () => {
    const r = await mount("a\n")
    type("b\n")
    r.unmount()
    render(<FileEditor entryId={entryId} tabId={tabId} path="/w/a.ts" onDone={onDone} />)
    await waitFor(() => expect(document.querySelector(".cm-content")).not.toBeNull())
    expect(doc()).toBe("a\nb\n")
    expect(document.querySelector(".file-editor-dot")).not.toBeNull()
  })
})
