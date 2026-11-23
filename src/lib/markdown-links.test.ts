import { describe, expect, it } from "vitest"
import { joinPath, linkTarget } from "./markdown-links"

describe("linkTarget", () => {
  it("sends the web and mail out, keeps anchors in the view", () => {
    expect(linkTarget("https://a.test/x", "/r")).toEqual({
      kind: "external",
      url: "https://a.test/x",
    })
    expect(linkTarget("mailto:a@b.test", "/r")).toEqual({
      kind: "external",
      url: "mailto:a@b.test",
    })
    expect(linkTarget("#session-survival", "/r")).toEqual({
      kind: "anchor",
      anchor: "session-survival",
    })
    expect(linkTarget("javascript:alert(1)", "/r")).toBeNull()
    expect(linkTarget("file:///etc/passwd", "/r")).toBeNull()
  })

  it("opens a relative path from the file's folder, with its anchor", () => {
    expect(linkTarget("GOTCHAS.md#fonts", "/r/docs")).toEqual({
      kind: "file",
      path: "/r/docs/GOTCHAS.md",
      anchor: "fonts",
    })
    expect(linkTarget("../src/a%20b.ts?x=1", "/r/docs")).toEqual({
      kind: "file",
      path: "/r/src/a b.ts",
    })
    expect(linkTarget("design/", "/r/docs")).toEqual({ kind: "folder", path: "/r/docs/design" })
  })

  it("reads a leading slash from the repo's root, else the file's folder", () => {
    expect(linkTarget("/docs/x.md", "/r/a/b", "/r")).toEqual({ kind: "file", path: "/r/docs/x.md" })
    expect(linkTarget("/x.md", "/r/a")).toEqual({ kind: "file", path: "/r/a/x.md" })
  })
})

describe("joinPath", () => {
  it("never goes above the root", () => {
    expect(joinPath("/a", "../../x")).toBe("/x")
    expect(joinPath("C:\\a\\b", "..\\c.md")).toBe("C:\\a\\c.md")
    expect(joinPath("C:\\a", "../../c.md")).toBe("C:\\c.md")
  })
})
