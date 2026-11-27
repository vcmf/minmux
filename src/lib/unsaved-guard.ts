// The page's side of the unsaved-file guards (docs/design/FILE_EDITING.md, "Unsaved changes"):
// main hears which files are unsaved (to name them), the page holds its unload while any are, a
// quit asks once and gets an answer settled first, and an OS file dropped where nothing takes it
// doesn't navigate the page away.
import { edits as appEdits, type EditStore } from "./edit-store"
import { ipc as appIpc, type Ipc as AppIpc } from "./ipc"

export const QUIT_SETTLE_MS = 4000 // a quit waits this long for saves before asking (main: 6 s)

type Ipc = Pick<AppIpc, "setUnsaved" | "onQuitCheck" | "quitReady">

/** Install the guards on `win`; returns their removal. */
export function installUnsavedGuard(
  edits: EditStore = appEdits,
  ipc: Ipc = appIpc,
  win: Window = window,
  settleMs = QUIT_SETTLE_MS,
): () => void {
  let last = ""
  const report = () => {
    const paths = edits.unsavedPaths()
    const key = paths.join("\0")
    if (key === last) return // only when the set changes, never per keystroke
    last = key
    ipc.setUnsaved(paths)
  }
  const off = edits.subscribe(report)
  const onUnload = (e: BeforeUnloadEvent) => {
    edits.flushAll() // a same-length edit typed just now counts
    if (!edits.unsaved().length) return
    e.preventDefault()
    e.returnValue = "" // Electron: main's will-prevent-unload decides
  }
  // Saves get `settleMs` to land; one still running then counts as unsaved (main asks).
  const offQuit = ipc.onQuitCheck(async () => {
    try {
      edits.flushAll()
      await Promise.race([edits.settledAll(), new Promise((r) => setTimeout(r, settleMs))])
      edits.flushAll()
    } catch {
      // settling failed: what's known to be unsaved is still the answer
    }
    return edits.unsavedPaths()
  })
  const fromOs = (e: DragEvent) => !!e.dataTransfer?.types.includes("Files")
  const noNavigate = (e: DragEvent) => {
    if (fromOs(e) && !e.defaultPrevented) e.preventDefault()
  }
  win.addEventListener("beforeunload", onUnload)
  win.addEventListener("dragover", noNavigate)
  win.addEventListener("drop", noNavigate)
  ipc.quitReady() // main may ask from now on
  return () => {
    off()
    offQuit()
    win.removeEventListener("beforeunload", onUnload)
    win.removeEventListener("dragover", noNavigate)
    win.removeEventListener("drop", noNavigate)
  }
}
