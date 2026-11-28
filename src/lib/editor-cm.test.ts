import { describe, expect, it } from "vitest"
import { EditorSelection, EditorState, type Transaction } from "@codemirror/state"
import { changesBetween, insertIndent, editorKeymap, indentFor } from "./editor-cm"

const run = (doc: string, sel: EditorSelection, indent: { tabs: boolean; width: number }) => {
  let state = EditorState.create({ doc, selection: sel, extensions: [indentFor(indent)] })
  insertIndent({ state, dispatch: (tr: Transaction) => void (state = tr.state) })
  return state
}

describe("insertIndent (Tab)", () => {
  it("spaces to the next stop of the file's width", () => {
    expect(run("ab", EditorSelection.single(0), { tabs: false, width: 2 }).doc.toString()).toBe(
      "  ab",
    )
    expect(run("ab", EditorSelection.single(1), { tabs: false, width: 4 }).doc.toString()).toBe(
      "a   b",
    )
    expect(run("   x", EditorSelection.single(3), { tabs: false, width: 2 }).doc.toString()).toBe(
      "    x",
    )
  })

  it("a tab in a tab-indented file", () => {
    expect(run("x", EditorSelection.single(0), { tabs: true, width: 2 }).doc.toString()).toBe("\tx")
  })

  it("a selection indents its lines a level", () => {
    const s = run("a\nb\n", EditorSelection.single(0, 3), { tabs: false, width: 2 })
    expect(s.doc.toString()).toBe("  a\n  b\n")
  })

  it("the cursor lands after what it typed", () => {
    expect(
      run("ab", EditorSelection.single(0), { tabs: false, width: 4 }).selection.main.head,
    ).toBe(4)
  })
})

describe("editorKeymap", () => {
  const keys = (isMac: boolean) =>
    editorKeymap(() => true, isMac).flatMap((b) => [b.key, b.mac].filter(Boolean))

  it("leaves the palette's keys and Tab focus mode to the app", () => {
    for (const isMac of [true, false]) {
      expect(keys(isMac)).not.toContain("Ctrl-k")
      expect(keys(isMac)).not.toContain("Shift-Mod-k")
      expect(keys(isMac)).not.toContain("Ctrl-m")
    }
  })

  it("has save, Tab, find; Ctrl+Shift+F finds off macOS", () => {
    expect(keys(true)).toEqual(expect.arrayContaining(["Mod-s", "Tab", "Mod-f"]))
    expect(keys(false)).toContain("Ctrl-Shift-f")
    expect(keys(true)).not.toContain("Ctrl-Shift-f")
  })
})

describe("changesBetween", () => {
  const lines = Array.from({ length: 1000 }, (_, i) => `line ${i}`)
  it("two distant edits stay two: a cursor between them stays put", () => {
    const a = lines.join("\n")
    const b = ["import x", ...lines.slice(0, 900), "changed", ...lines.slice(901)].join("\n")
    let state = EditorState.create({ doc: a, selection: { anchor: a.indexOf("line 500") } })
    state = state.update({ changes: changesBetween(a, b) }).state
    expect(state.doc.toString()).toBe(b)
    expect(state.doc.lineAt(state.selection.main.head).text).toBe("line 500")
  })
  it("no change, no edits", () => {
    expect(changesBetween("same", "same")).toEqual([])
  })
})
