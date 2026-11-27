import { describe, expect, it, vi } from "vitest"
import { EditStore } from "./edit-store"
import { installUnsavedGuard } from "./unsaved-guard"

function setup(settleMs = 50) {
  const edits = new EditStore(vi.fn(), vi.fn(), {
    pin: vi.fn(),
    saved: vi.fn(),
    ticket: vi.fn(() => 1),
  })
  let answer: (() => Promise<string[]>) | null = null
  const ipc = {
    setUnsaved: vi.fn(),
    onQuitCheck: vi.fn((fn: () => Promise<string[]>) => ((answer = fn), () => (answer = null))),
    quitReady: vi.fn(),
  }
  const off = installUnsavedGuard(edits, ipc as never, window, settleMs)
  return { edits, ipc, off, answer: () => answer!() }
}

describe("installUnsavedGuard", () => {
  it("tells main when the unsaved set changes, not per change", () => {
    const { edits, ipc, off } = setup()
    expect(ipc.quitReady).toHaveBeenCalled()
    edits.start("e", "/w/a.ts", undefined, "a", "h")
    edits.setDirty("e", true)
    edits.keep("e", {}) // no publish
    edits.setDirty("e", true) // no change
    expect(ipc.setUnsaved).toHaveBeenCalledTimes(1)
    expect(ipc.setUnsaved).toHaveBeenLastCalledWith(["/w/a.ts"])
    edits.setDirty("e", false)
    expect(ipc.setUnsaved).toHaveBeenLastCalledWith([])
    off()
  })

  it("holds the unload while anything is unsaved (a pending check settled first)", () => {
    const { edits, off } = setup()
    edits.start("e", "/w/a.ts", undefined, "a", "h")
    const unload = () => {
      const e = new Event("beforeunload", { cancelable: true }) as BeforeUnloadEvent
      window.dispatchEvent(e)
      return e.defaultPrevented
    }
    expect(unload()).toBe(false)
    edits.setFlusher(() => edits.setDirty("e", true)) // a same-length edit just typed
    expect(unload()).toBe(true)
    off()
    expect(unload()).toBe(false) // removed
  })

  it("answers a quit once saves settle, or after the wait with one still running", async () => {
    const { edits, answer, off } = setup(20)
    edits.start("e", "/w/a.ts", undefined, "a", "h")
    let finish!: () => void
    edits.track("e", new Promise<void>((r) => (finish = r)))
    edits.setDirty("e", true)
    const first = answer()
    edits.setDirty("e", false)
    finish()
    expect(await first).toEqual([]) // the save landed
    edits.setDirty("e", true)
    edits.track("e", new Promise<void>(() => {})) // hung
    expect(await answer()).toEqual(["/w/a.ts"]) // the wait ran out: still unsaved
    off()
  })

  it("an answer whose settling throws still answers what's unsaved", async () => {
    const { edits, answer, off } = setup()
    edits.start("e", "/w/a.ts", undefined, "a", "h")
    edits.setDirty("e", true)
    edits.setFlusher(() => {
      throw new Error("boom")
    })
    expect(await answer()).toEqual(["/w/a.ts"])
    off()
  })

  it("an OS file dropped where nothing takes it doesn't navigate; others are left alone", () => {
    const { off } = setup()
    const drop = (types: string[], taken = false) => {
      const e = new Event("drop", { cancelable: true }) as DragEvent
      Object.defineProperty(e, "dataTransfer", { value: { types } })
      if (taken) e.preventDefault()
      window.dispatchEvent(e)
      return e.defaultPrevented
    }
    expect(drop(["Files"])).toBe(true)
    expect(drop(["text/plain"])).toBe(false) // a tab dragged inside the app
    off()
    expect(drop(["Files"])).toBe(false)
  })
})
