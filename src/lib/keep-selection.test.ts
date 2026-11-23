import { describe, it, expect, afterEach } from "vitest"
import { restoreSelection, saveSelection } from "./keep-selection"

const row = (id: string, html: string) =>
  `<div data-row="${id}"><span class="file-view-no">1</span><span class="file-view-code">${html}</span></div>`

function mount(html: string): HTMLElement {
  const root = document.createElement("div")
  root.innerHTML = html
  document.body.appendChild(root)
  return root
}
const code = (root: HTMLElement, id: string) =>
  root.querySelector(`[data-row="${id}"] .file-view-code`)!

afterEach(() => {
  document.body.innerHTML = ""
  window.getSelection()?.removeAllRanges()
})

describe("keep-selection", () => {
  it("keeps a selection across a line's plain → highlighted HTML", () => {
    const root = mount(row("s1", "const answer = 42") + row("s2", "return answer"))
    const t1 = code(root, "s1").firstChild!
    const t2 = code(root, "s2").firstChild!
    window.getSelection()!.setBaseAndExtent(t1, 6, t2, 6) // "answer = 42\nreturn"
    const saved = saveSelection(root)!
    expect(saved).toEqual({ anchor: { row: "s1", off: 6 }, focus: { row: "s2", off: 6 } })

    code(root, "s1").innerHTML = '<span class="k">const</span> answer = <span class="n">42</span>'
    code(root, "s2").innerHTML = '<span class="k">return</span> answer'
    restoreSelection(root, saved)
    const sel = window.getSelection()!
    expect(sel.anchorNode?.textContent).toBe(" answer = ")
    expect(sel.anchorOffset).toBe(1)
    expect(sel.focusNode?.textContent).toBe("return")
    expect(sel.focusOffset).toBe(6)
  })

  it("keeps a backward selection's direction", () => {
    const root = mount(row("s1", "abcdef"))
    const t = code(root, "s1").firstChild!
    window.getSelection()!.setBaseAndExtent(t, 5, t, 2)
    const saved = saveSelection(root)!
    code(root, "s1").innerHTML = "<b>abc</b>def"
    restoreSelection(root, saved)
    const sel = window.getSelection()!
    expect([sel.anchorNode?.textContent, sel.anchorOffset]).toEqual(["def", 2])
    expect([sel.focusNode?.textContent, sel.focusOffset]).toEqual(["abc", 2])
  })

  it("has nothing to keep: no selection, a collapsed one, or one outside", () => {
    const root = mount(row("s1", "abc"))
    expect(saveSelection(root)).toBeNull()
    const t = code(root, "s1").firstChild!
    window.getSelection()!.setBaseAndExtent(t, 1, t, 1)
    expect(saveSelection(root)).toBeNull()
    const other = mount("<p>elsewhere</p>")
    window.getSelection()!.selectAllChildren(other)
    expect(saveSelection(root)).toBeNull()
  })

  it("skips a row that isn't rendered any more", () => {
    const root = mount(row("s1", "abc") + row("s2", "def"))
    window
      .getSelection()!
      .setBaseAndExtent(code(root, "s1").firstChild!, 1, code(root, "s2").firstChild!, 2)
    const saved = saveSelection(root)!
    root.querySelector('[data-row="s2"]')!.remove()
    window.getSelection()!.removeAllRanges()
    restoreSelection(root, saved)
    expect(window.getSelection()!.rangeCount).toBe(0)
  })
})
