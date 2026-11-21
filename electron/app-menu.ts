import type { MenuItemConstructorOptions } from "electron"

/** macOS's application menu: Electron's default, except ⌘W — a plain window close that main
 *  can tell from the red button (that one runs the guarded quit). */
export function macMenuTemplate(closeWindow: () => void): MenuItemConstructorOptions[] {
  return [
    { role: "appMenu" },
    {
      label: "File",
      submenu: [{ label: "Close Window", accelerator: "Cmd+W", click: () => closeWindow() }],
    },
    { role: "editMenu" },
    { role: "viewMenu" },
    { role: "windowMenu" },
  ]
}
