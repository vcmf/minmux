import { describe, it, expect } from "vitest"
import { osMayOpen } from "./open-policy"

const file = { isFile: true }

describe("osMayOpen", () => {
  it("documents, images and media open in their app", () => {
    for (const p of ["/a/r.pdf", "/a/p.PNG", "/a/v.mov", "/a/s.xlsx"])
      expect(osMayOpen(p, file, "darwin")).toBe(true)
  })

  it("never what a platform runs on a double-click", () => {
    expect(osMayOpen("/a/x.command", file, "darwin")).toBe(false)
    expect(osMayOpen("C:\\a\\x.vbs", file, "win32")).toBe(false)
    expect(osMayOpen("C:\\a\\x.js", file, "win32")).toBe(false)
    for (const ext of ["rb", "lua", "php", "pl"])
      expect(osMayOpen(`C:\\a\\x.${ext}`, file, "win32")).toBe(false)
    expect(osMayOpen("/a/x.rb", file, "darwin")).toBe(true) // an editor opens it there
    expect(osMayOpen("/a/x.desktop", file, "linux")).toBe(false)
    expect(osMayOpen("/a/x.AppImage", file, "linux")).toBe(false)
  })

  it("an unknown type, a file with no extension or a folder (bundle): no", () => {
    expect(osMayOpen("/a/x.weird", file, "darwin")).toBe(false)
    expect(osMayOpen("/a/run-me", file, "darwin")).toBe(false)
    expect(osMayOpen("/a/Foo.app", { isFile: false }, "darwin")).toBe(false)
  })

  it("an allowlisted type opens by its type, whatever its mode (USB drives mark files +x)", () => {
    expect(osMayOpen("/Volumes/usb/report.pdf", file, "darwin")).toBe(true)
    expect(osMayOpen("C:\\a\\r.pdf", file, "win32")).toBe(true)
  })
})
