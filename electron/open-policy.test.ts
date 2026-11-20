import { describe, it, expect } from "vitest"
import { osMayOpen } from "./open-policy"

const file = { isFile: true, mode: 0o644 }

describe("osMayOpen", () => {
  it("documents, images and media open in their app", () => {
    for (const p of ["/a/r.pdf", "/a/p.PNG", "/a/v.mov", "/a/s.xlsx"])
      expect(osMayOpen(p, file, "darwin")).toBe(true)
  })

  it("never what a platform runs on a double-click", () => {
    expect(osMayOpen("/a/x.command", file, "darwin")).toBe(false)
    expect(osMayOpen("C:\\\\a\\\\x.vbs", file, "win32")).toBe(false)
    expect(osMayOpen("C:\\\\a\\\\x.js", file, "win32")).toBe(false)
    expect(osMayOpen("/a/x.desktop", file, "linux")).toBe(false)
    expect(osMayOpen("/a/x.AppImage", file, "linux")).toBe(false)
  })

  it("an unknown type, a file with no extension, a folder (bundle) or the exec bit: no", () => {
    expect(osMayOpen("/a/x.weird", file, "darwin")).toBe(false)
    expect(osMayOpen("/a/run-me", file, "darwin")).toBe(false)
    expect(osMayOpen("/a/Foo.app", { isFile: false, mode: 0o755 }, "darwin")).toBe(false)
    expect(osMayOpen("/a/notes.txt", { isFile: true, mode: 0o755 }, "linux")).toBe(false)
  })

  it("Windows has no exec bit; its list decides", () => {
    expect(osMayOpen("C:\\\\a\\\\r.pdf", { isFile: true, mode: 0o777 }, "win32")).toBe(true)
  })
})
