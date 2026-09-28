// Pure model for the file/folder right-click menu: which items appear, their
// labels, and whether they're enabled — plus viewport clamping for the popup.
// The component (context-menu.tsx) maps each item's `id` to an IPC effect; this
// stays free of DOM/IPC so it's unit-testable.

/** Whether the configured editor can open a file, for the menu label/enabled state.
 *  Shared shape: main fills it (editor-detect.ts), the renderer types it (ipc.ts). */
export interface EditorInfo {
  available: boolean
  name: string
}

// A path we can safely hand to the OS on the host: POSIX-absolute (/…) or a Windows
// drive path (C:\… / C:/…). Guards the file menu against repo-relative paths (empty
// git root) and WSL paths that the Windows/macOS host can't resolve.
export function isAbsoluteHostPath(p: string, platform?: string): boolean {
  if (/^[A-Za-z]:[\\/]/.test(p) || /^\\\\/.test(p)) return true
  return /^\//.test(p) && platform !== "win32" // on Windows a /… path is Git Bash's, not the host's
}

// Platform-appropriate label for the reveal-in-file-manager action.
export function revealLabel(platform: string): string {
  if (platform === "darwin") return "Reveal in Finder"
  if (platform === "win32") return "Reveal in Explorer"
  return "Show in File Manager"
}

export type FileActionId =
  "preview" | "open" | "setRoot" | "reveal" | "copyPath" | "copyRel" | "openHere"

export interface MenuItemSpec<Id extends string = FileActionId> {
  id: Id
  label: string
  disabled?: boolean
  hint?: string // muted trailing note, e.g. "not found"
  separatorBefore?: boolean
}

export interface FileMenuInput {
  isDir: boolean
  editorName: string // "" when no editor is available
  editorAvailable: boolean
  revealLabel: string // OS-specific, from editor-detect.revealLabel
}

/** Build the ordered menu for a file or folder row. Folders skip "Open in editor"
 *  (the template targets a file); everything else is available everywhere. */
export function fileMenuItems(input: FileMenuInput): MenuItemSpec[] {
  const items: MenuItemSpec[] = []
  if (input.isDir) {
    items.push({ id: "setRoot", label: "Set as root folder" })
  } else {
    items.push({ id: "preview", label: "Preview" })
    items.push({
      id: "open",
      label: input.editorAvailable ? `Open in ${input.editorName}` : "Open in editor",
      disabled: !input.editorAvailable,
      hint: input.editorAvailable ? undefined : "not found",
    })
  }
  items.push({ id: "reveal", label: input.revealLabel })
  items.push({ id: "copyPath", label: "Copy path", separatorBefore: true })
  items.push({ id: "copyRel", label: "Copy relative path" })
  return items
}

/** The sidebar's folder-line menu; `revealHint` = why Reveal is unavailable (e.g. a WSL path). */
export function folderMenuItems(revealLabel: string, revealHint?: string): MenuItemSpec[] {
  return [
    { id: "copyPath", label: "Copy path" },
    { id: "openHere", label: "Open terminal here" },
    {
      id: "reveal",
      label: revealLabel,
      disabled: !!revealHint,
      hint: revealHint,
      separatorBefore: true,
    },
  ]
}

/** Clamp a menu's top-left so it stays fully inside the viewport (flip/nudge in). */
export function clampMenuPosition(
  x: number,
  y: number,
  menuW: number,
  menuH: number,
  viewW: number,
  viewH: number,
  pad = 6,
): { x: number; y: number } {
  const cx = Math.max(pad, Math.min(x, viewW - menuW - pad))
  const cy = Math.max(pad, Math.min(y, viewH - menuH - pad))
  return { x: cx, y: cy }
}
