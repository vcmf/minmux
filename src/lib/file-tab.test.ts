import { describe, it, expect } from "vitest"
import { imageMime, opensInTab } from "./file-tab"

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
})
