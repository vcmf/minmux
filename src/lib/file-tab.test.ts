import { describe, it, expect } from "vitest"
import { imageMime, opensInTab, sameStamp } from "./file-tab"

describe("file tab", () => {
  it("text, code and images open in a tab; documents and binaries don't", () => {
    for (const p of ["/a/x.ts", "/a/README.md", "/a/Makefile", "/a/.env", "/a/p.PNG"])
      expect(opensInTab(p)).toBe(true)
    for (const p of ["/a/doc.pdf", "/a/v.MP4", "/a/x.zip", "C:\\\\a\\\\setup.exe", "/a/Foo.app"])
      expect(opensInTab(p)).toBe(false)
  })

  it("imageMime knows pictures by extension, case-insensitively", () => {
    expect(imageMime("/a/b.JPG")).toBe("image/jpeg")
    expect(imageMime("/a/b.svg")).toBeUndefined() // shown as its text
  })

  it("sameStamp: every field must match; a coarse mtime is trusted only once old", () => {
    const a = { size: 5, mtimeMs: 1000.5, ctimeMs: 1000.5, ino: 7 }
    expect(sameStamp(a, { ...a }, 1001)).toBe(true)
    expect(sameStamp(a, { ...a, ino: 8 }, 1001)).toBe(false)
    const coarse = { size: 5, mtimeMs: 2000, ctimeMs: 2000, ino: 7 } // FAT: whole seconds
    expect(sameStamp(coarse, { ...coarse }, 3000)).toBe(false) // could hide a same-size edit
    expect(sameStamp(coarse, { ...coarse }, 6000)).toBe(true)
  })
})
