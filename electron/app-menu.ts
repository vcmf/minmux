import type { BaseWindow, MenuItemConstructorOptions } from "electron"

/** macOS app menu: Electron's default, with ⌘W as a plain close (not the guarded quit). */
export function macMenuTemplate(
  closeWindow: (focused?: BaseWindow) => void,
): MenuItemConstructorOptions[] {
  return [
    { role: "appMenu" },
    {
      label: "File",
      submenu: [
        {
          label: "Close Window",
          accelerator: "Cmd+W",
          click: (_i, focused) => closeWindow(focused),
        },
      ],
    },
    { role: "editMenu" },
    { role: "viewMenu" },
    { role: "windowMenu" },
  ]
}
