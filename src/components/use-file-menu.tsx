import { useState, type MouseEvent, type ReactNode } from "react"
import { useStore } from "../store"
import { ipc } from "../lib/ipc"
import { getActiveWsl } from "../lib/use-active-cwd"
import { ContextMenu } from "./context-menu"
import { baseName } from "../lib/file-tree"
import {
  fileMenuItems,
  revealLabel,
  isAbsoluteHostPath,
  type FileActionId,
} from "../lib/file-actions"

// The row a menu was opened on. `abs` is the absolute host path (for reveal/open/copy),
// `rel` the path shown relative to the panel root (for "Copy relative path").
export interface FileTarget {
  abs: string
  rel: string
  isDir: boolean
}

interface MenuState extends FileTarget {
  x: number
  y: number
}

/** Shared file/folder right-click menu for the files + changes panels: one hook holds
 *  the open menu, builds items from the current editor/platform, and dispatches each
 *  action to the IPC seam. Returns the menu node to render and an onContextMenu opener. */
export function useFileMenu(
  // A folder view: "Set as root" re-roots it, and its own WSL-ness (not the active pane's) counts.
  opts: { onSetRoot?: (abs: string) => void; wsl?: boolean } = {},
): {
  menu: ReactNode
  openFileMenu: (e: MouseEvent, target: FileTarget) => void
} {
  const [menu, setMenu] = useState<MenuState | null>(null)
  const platform = useStore((s) => s.platform)
  const editor = useStore((s) => s.editor)

  const openFileMenu = (e: MouseEvent, target: FileTarget) => {
    e.preventDefault()
    // The actions run on the host fs (reveal/open/copy), so skip when we don't have a
    // resolvable host path: a repo-relative path (empty git root) or a WSL pane whose
    // paths the Windows/macOS host can't reach.
    const wsl = opts.onSetRoot ? opts.wsl : !!getActiveWsl()
    if (wsl || !isAbsoluteHostPath(target.abs, platform)) return
    setMenu({ ...target, x: e.clientX, y: e.clientY })
    // Re-probe on open so an editor installed mid-session (without a settings change)
    // is reflected in the label/enabled state; main memoises so this stays cheap.
    void ipc.editorInfo().then((info) => useStore.getState().setEditor(info))
  }

  const dispatch = (id: FileActionId) => {
    if (!menu) return
    if (id === "preview")
      // No wsl here: openFileMenu refuses to open the menu on a WSL pane (#21), so this
      // path is native-only. WSL preview is the left-click path (files-panel).
      useStore.getState().setPreview({ abs: menu.abs, name: baseName(menu.abs) })
    else if (id === "setRoot" && opts.onSetRoot) opts.onSetRoot(menu.abs)
    else if (id === "setRoot") {
      const s = useStore.getState()
      const sid = s.tabs.find((t) => t.id === s.activeTabId)?.activeSessionId
      if (sid) s.setPaneRoot(sid, menu.abs)
    } else if (id === "open") ipc.openFile("", menu.abs)
    else if (id === "reveal") ipc.revealPath(menu.abs)
    else if (id === "copyPath") ipc.clipboardWrite(menu.abs)
    else if (id === "copyRel") ipc.clipboardWrite(menu.rel)
  }

  const node = menu ? (
    <ContextMenu
      x={menu.x}
      y={menu.y}
      items={fileMenuItems({
        isDir: menu.isDir,
        editorName: editor?.name ?? "",
        editorAvailable: editor?.available ?? false,
        revealLabel: revealLabel(platform),
      })}
      onSelect={dispatch}
      onClose={() => setMenu(null)}
    />
  ) : null

  return { menu: node, openFileMenu }
}
