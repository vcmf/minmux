import { describe, it, expect } from "vitest"
import { splitHighlighted } from "./split-highlighted"

describe("splitHighlighted", () => {
  it("one string per line", () => {
    expect(splitHighlighted("a\nb\n")).toEqual(["a", "b", ""])
  })

  it("a span crossing lines is closed and reopened on each", () => {
    const html = '<span class="c">/* one\ntwo */</span> x'
    expect(splitHighlighted(html)).toEqual([
      '<span class="c">/* one</span>',
      '<span class="c">two */</span> x',
    ])
  })

  it("nested spans keep their order", () => {
    const html = '<span class="a">x<span class="b">y\nz</span>w</span>'
    expect(splitHighlighted(html)).toEqual([
      '<span class="a">x<span class="b">y</span></span>',
      '<span class="a"><span class="b">z</span>w</span>',
    ])
  })

  it("escaped text stays escaped", () => {
    expect(splitHighlighted("a &lt; b\n&amp;")).toEqual(["a &lt; b", "&amp;"])
  })
})
