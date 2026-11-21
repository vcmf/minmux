import { describe, expect, it, vi } from "vitest"
import type { MenuItemConstructorOptions } from "electron"
import { macMenuTemplate } from "./app-menu"

const items = (t: MenuItemConstructorOptions[]): MenuItemConstructorOptions[] =>
  t.flatMap((i) => [i, ...(Array.isArray(i.submenu) ? items(i.submenu) : [])])

describe("macMenuTemplate", () => {
  it("⌘W runs the plain close, and no stock close item competes with it", () => {
    const close = vi.fn()
    const all = items(macMenuTemplate(close))
    const cmdW = all.filter((i) => i.accelerator === "Cmd+W")
    expect(cmdW).toHaveLength(1)
    ;(cmdW[0]!.click as () => void)()
    expect(close).toHaveBeenCalledOnce()
    expect(all.some((i) => i.role === "close")).toBe(false)
  })

  it("keeps the stock menus (copy / paste, zoom, full screen, quit)", () => {
    const roles = macMenuTemplate(() => {}).map((i) => i.role)
    expect(roles).toEqual(["appMenu", undefined, "editMenu", "viewMenu", "windowMenu"])
  })
})
