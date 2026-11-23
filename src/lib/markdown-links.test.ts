import { describe, expect, it } from "vitest"
import { joinPath, linkTarget, prLinkTarget } from "./markdown-links"

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

describe("linkTarget: no path", () => {
  it("a link to the file itself goes to its anchor, or nowhere", () => {
    expect(linkTarget("?plain=1", "/r/docs")).toBeNull()
    expect(linkTarget(".", "/r/docs")).toBeNull()
    expect(linkTarget("./#x", "/r/docs")).toEqual({ kind: "anchor", anchor: "x" })
    expect(linkTarget("..", "/r/docs")).toEqual({ kind: "folder", path: "/r" })
  })
})

describe("prLinkTarget", () => {
  it("sends a relative path to the repo's file on GitHub, the rest as in a file", () => {
    expect(prLinkTarget("docs/x.md#a", "o/r")).toEqual({
      kind: "external",
      url: "https://github.com/o/r/blob/HEAD/docs/x.md#a",
    })
    expect(prLinkTarget("./src/", "o/r")).toEqual({
      kind: "external",
      url: "https://github.com/o/r/blob/HEAD/src",
    })
    expect(prLinkTarget("../README.md", "o/r")).toEqual({
      kind: "external",
      url: "https://github.com/o/r/blob/HEAD/README.md",
    })
    expect(prLinkTarget("docs/../a b.md", "o/r")).toEqual({
      kind: "external",
      url: "https://github.com/o/r/blob/HEAD/a%20b.md",
    })
    expect(prLinkTarget("https://a.test", "o/r")).toEqual({
      kind: "external",
      url: "https://a.test",
    })
    expect(prLinkTarget("#x", "o/r")).toEqual({ kind: "anchor", anchor: "x" })
    expect(prLinkTarget("javascript:x", "o/r")).toBeNull()
  })
})

describe("joinPath", () => {
  it("keeps a UNC path's server and share", () => {
    const dir = "\\\\wsl.localhost\\Ubuntu\\home\\u\\docs"
    expect(joinPath(dir, "GOTCHAS.md")).toBe("\\\\wsl.localhost\\Ubuntu\\home\\u\\docs\\GOTCHAS.md")
    expect(joinPath("\\\\srv\\share", "../../x.md")).toBe("\\\\srv\\share\\x.md")
  })

  it("never goes above the root", () => {
    expect(joinPath("/a", "../../x")).toBe("/x")
    expect(joinPath("C:\\a\\b", "..\\c.md")).toBe("C:\\a\\c.md")
    expect(joinPath("C:\\a", "../../c.md")).toBe("C:\\c.md")
  })
})
