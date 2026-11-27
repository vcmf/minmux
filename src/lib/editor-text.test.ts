import { describe, expect, it } from "vitest"
import {
  applyChanges,
  detectIndent,
  fromDisk,
  keepsTrailingSpace,
  saveCleanup,
  toDisk,
} from "./editor-text"

const clean = (text: string, keep: number[] = [], keepTrailing = false) =>
  applyChanges(text, saveCleanup(text, new Set(keep), keepTrailing))

describe("fromDisk / toDisk", () => {
  it("LF text passes through", () => {
    const t = fromDisk("a\nb\n")
    expect(t).toEqual({ text: "a\nb\n", bom: false, eol: "\n", mixed: false })
    expect(toDisk(t.text, t)).toBe("a\nb\n")
  })

  it("CRLF text edits as LF and goes back as CRLF", () => {
    const t = fromDisk("a\r\nb\r\n")
    expect(t).toMatchObject({ text: "a\nb\n", eol: "\r\n", mixed: false })
    expect(toDisk(t.text + "c\n", t)).toBe("a\r\nb\r\nc\r\n")
  })

  it("mixed endings take the most common, and say so", () => {
    const t = fromDisk("a\r\nb\r\nc\n")
    expect(t).toMatchObject({ text: "a\nb\nc\n", eol: "\r\n", mixed: true })
    expect(fromDisk("a\nb\nc\r\n")).toMatchObject({ eol: "\n", mixed: true })
  })

  it("a BOM is taken off and put back", () => {
    const t = fromDisk("\uFEFFx\n")
    expect(t).toMatchObject({ text: "x\n", bom: true })
    expect(toDisk(t.text, t)).toBe("\uFEFFx\n")
  })

  it("a lone \\r stays text", () => {
    expect(fromDisk("a\rb\n").text).toBe("a\rb\n")
  })
})

describe("keepsTrailingSpace", () => {
  it("markdown, diffs and snapshots keep it", () => {
    for (const p of ["/r/README.md", "a.MDX", "x.markdown", "fix.patch", "a.diff", "t.snap"])
      expect(keepsTrailingSpace(p)).toBe(true)
  })
  it("code doesn't", () => {
    for (const p of ["/r/a.ts", "Makefile", "/r/.md/x.ts", ".md"])
      expect(keepsTrailingSpace(p)).toBe(false)
  })
})

describe("saveCleanup", () => {
  it("trims trailing spaces and tabs on every line", () => {
    expect(clean("a  \n\tb\t \nc\n")).toBe("a\n\tb\nc\n")
  })

  it("keeps a cursor line as it is", () => {
    expect(clean("a  \n    \nc \n", [1])).toBe("a\n    \nc\n")
  })

  it("keeps trailing spaces where they mean something, still fixing the end", () => {
    expect(clean("a  \nb\n\n\n", [], true)).toBe("a  \nb\n")
  })

  it("drops trailing blank lines down to one newline", () => {
    expect(clean("a\n\n\n")).toBe("a\n")
    expect(clean("a\n  \n\t\n")).toBe("a\n")
  })

  it("adds the final newline", () => {
    expect(clean("a")).toBe("a\n")
    expect(clean("a  ")).toBe("a\n")
  })

  it("keeps a trailing blank line that holds a cursor", () => {
    expect(clean("a\n\n  \n\n", [2])).toBe("a\n\n  \n")
  })

  it("a cursor after the final newline changes nothing there", () => {
    expect(clean("a\n\n", [2])).toBe("a\n\n")
    expect(clean("a\n", [1])).toBe("a\n")
  })

  it("an empty or blank file ends empty", () => {
    expect(clean("")).toBe("")
    expect(saveCleanup("", new Set())).toEqual([])
    expect(clean("\n \n\n")).toBe("")
  })

  it("a clean file needs no change", () => {
    expect(saveCleanup("a\n  b\n", new Set())).toEqual([])
  })

  it("edits are in order and don't overlap", () => {
    const ch = saveCleanup("a \nb \n\n", new Set())
    for (let i = 1; i < ch.length; i++) expect(ch[i]!.from).toBeGreaterThanOrEqual(ch[i - 1]!.to)
  })
})

describe("detectIndent", () => {
  it("two-space code", () => {
    expect(detectIndent("a {\n  b {\n    c\n  }\n}\n", "/x.ts", 4)).toEqual({
      tabs: false,
      width: 2,
    })
  })

  it("four-space Python against a setting of 2", () => {
    const py = "def f():\n    if x:\n        y()\n    return 1\n"
    expect(detectIndent(py, "/x.py", 2)).toEqual({ tabs: false, width: 4 })
  })

  it("tabs", () => {
    expect(detectIndent("a {\n\tb\n\t\tc\n}\n", "/x.c", 2)).toEqual({ tabs: true, width: 2 })
  })

  it("no indentation: the setting", () => {
    expect(detectIndent("a\nb\n", "/x.txt", 4)).toEqual({ tabs: false, width: 4 })
  })

  it("a doc comment's one-space star isn't a step", () => {
    const ts = "/**\n * a\n */\nf() {\n  x\n}\n"
    expect(detectIndent(ts, "/x.ts", 4).width).toBe(2)
  })

  it("Makefiles and Go always use tabs", () => {
    for (const p of ["/r/Makefile", "/r/rules.mk", "/r/main.go", "/r/go.mod", "C:\\r\\GNUmakefile"])
      expect(detectIndent("a:\n  b\n", p, 2).tabs).toBe(true)
  })
})
