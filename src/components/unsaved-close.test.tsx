import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { render, screen, fireEvent, act, waitFor } from "@testing-library/react"
import { CloseConfirmDialog } from "./close-confirm-dialog"
import { UnsavedMark } from "./unsaved-mark"
import { useStore } from "../store"
import { edits } from "../lib/edit-store"
import { resetStore, testShell } from "../test/helpers"

vi.mock("../terminal/terminal-manager", () => ({
  TerminalManager: { focus: vi.fn(), dispose: vi.fn() },
}))

const st = () => useStore.getState()
const tab = () => st().tabs[0]!
const pane = () => {
  const root = tab().root
  if (root.type !== "leaf") throw new Error("expected leaf")
  return root
}

/** A tab whose pane holds a terminal and a file being edited, unsaved. */
function setup(dirty = true) {
  st().newTab(testShell)
  st().openFile("/w/a.ts")
  const id = tab().activeEntryId
  edits.start(id, "/w/a.ts", undefined, "x\n", "h0")
  if (dirty) edits.setDirty(id, true)
  return id
}

let saver = vi.fn(async (): Promise<"saved" | "error"> => "saved")
beforeEach(() => {
  resetStore()
  useStore.setState({ closeConfirm: null })
  saver = vi.fn(async (): Promise<"saved" | "error"> => "saved")
  edits.setSaver(saver)
})
afterEach(() => {
  for (const id of edits.unsaved()) edits.stop(id)
})

describe("closing a file with unsaved changes", () => {
  it("asks Save / Don't save / Cancel; Cancel keeps it", () => {
    const id = setup()
    st().requestCloseEntry(tab().id, id)
    render(<CloseConfirmDialog />)
    expect(screen.getByText('Save changes to "a.ts"?')).toBeInTheDocument()
    expect(document.activeElement?.textContent).toBe("Save") // the safe default
    fireEvent.click(screen.getByText("Cancel"))
    expect(st().objects[id]).toBeDefined()
    expect(edits.isUnsaved(id)).toBe(true)
  })

  it("Don't save closes it, and its edit goes", () => {
    const id = setup()
    st().requestCloseEntry(tab().id, id)
    render(<CloseConfirmDialog />)
    fireEvent.click(screen.getByText("Don't save"))
    expect(st().objects[id]).toBeUndefined()
    expect(edits.get(id)).toBeUndefined()
  })

  it("Save saves, then closes", async () => {
    const id = setup()
    st().requestCloseEntry(tab().id, id)
    render(<CloseConfirmDialog />)
    fireEvent.click(screen.getByText("Save"))
    await waitFor(() => expect(st().objects[id]).toBeUndefined())
    expect(saver).toHaveBeenCalledWith(id)
  })

  it("a save that doesn't go through keeps it open, shown", async () => {
    const id = setup()
    saver.mockResolvedValue("error")
    st().setActivePane(tab().id, pane().entryIds[0]!) // the terminal in front
    st().requestCloseEntry(tab().id, id)
    await act(() => st().saveAndClose())
    expect(st().objects[id]).toBeDefined()
    expect(tab().activeEntryId).toBe(id)
  })

  it("a saved file closes without asking", () => {
    const id = setup(false)
    st().requestCloseEntry(tab().id, id)
    expect(st().closeConfirm).toBeNull()
    expect(st().objects[id]).toBeUndefined()
  })
})

describe("closing a pane or session holding unsaved files", () => {
  it("the pane asks, naming the file; confirming drops it with the pane", () => {
    const id = setup()
    st().requestClosePane(tab().id, pane().id)
    expect(st().closeConfirm).toMatchObject({ kind: "unsaved", files: ["a.ts"], terminals: 1 })
    render(<CloseConfirmDialog />)
    expect(screen.queryByText("Save")).toBeNull() // several things close: no per-file Save
    fireEvent.click(screen.getByText("Discard and close"))
    expect(st().tabs).toHaveLength(0)
    expect(edits.get(id)).toBeUndefined()
  })

  it("the session asks too", () => {
    setup()
    st().requestCloseTab(tab().id)
    expect(st().closeConfirm).toMatchObject({ kind: "unsaved", files: ["a.ts"] })
    st().confirmClose()
    expect(st().tabs).toHaveLength(0)
  })
})

describe("UnsavedMark", () => {
  it("shows while the file has unsaved changes", () => {
    const id = setup(false)
    const { container } = render(<UnsavedMark id={id} />)
    expect(container.querySelector(".unsaved-mark")).toBeNull()
    act(() => edits.setDirty(id, true))
    expect(container.querySelector(".unsaved-mark")).not.toBeNull()
  })
})
