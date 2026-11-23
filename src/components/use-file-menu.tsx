import { useState, type MouseEvent, type ReactNode } from "react"
import { useStore } from "../store"
import { ipc } from "../lib/ipc"
import { ContextMenu } from "./context-menu"
import { baseName } from "../lib/file-tree"
import {
  fileMenuItems,
  revealLabel,
  isAbsoluteHostPath,
  isHtmlPath,
  type FileActionId,
} from "../lib/file-actions"

// The row a menu was opened on. `abs` is the absolute host path (for reveal/open/copy),
// `rel` the path shown relative to the folder tab's root (for "Copy relative path").
export interface FileTarget {
  abs: string
  rel: string
  isDir: boolean
}

interface MenuState extends FileTarget {
  x: number
  y: number
}

// One hook holds the open menu, builds items from the current editor/platform, and dispatches
// each action to the IPC seam.
/** A folder tab's file/folder right-click menu: the node to render and its opener. */
export function useFileMenu(
  // "Set as root" re-roots the folder tab; its own WSL-ness counts.
  opts: { onSetRoot: (abs: string) => void; wsl: boolean },
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
    if (opts.wsl || !isAbsoluteHostPath(target.abs, platform)) return
    setMenu({ ...target, x: e.clientX, y: e.clientY })
    // Re-probe on open so an editor installed mid-session (without a settings change)
    // is reflected in the label/enabled state; main memoises so this stays cheap.
    void ipc.editorInfo().then((info) => useStore.getState().setEditor(info))
  }

  const dispatch = (id: FileActionId) => {
    if (!menu) return
    if (id === "preview")
      // No wsl here: openFileMenu refuses to open the menu on a WSL folder (#21).
      useStore.getState().setPreview({ abs: menu.abs, name: baseName(menu.abs) })
    else if (id === "setRoot") opts.onSetRoot(menu.abs)
    else if (id === "open") ipc.openFile("", menu.abs)
    else if (id === "browser")
      ipc.openPath(menu.abs) // the OS default app: its browser
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
        html: !menu.isDir && isHtmlPath(menu.abs),
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
