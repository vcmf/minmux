import { describe, expect, it } from "vitest"
import { blockAt, topBlock } from "./markdown-scroll"

// Blocks laid out at the given tops and heights (jsdom has no layout).
function view(blocks: { line?: number; top: number; h: number }[], scrollTop: number) {
  const body = document.createElement("div")
  for (const b of blocks) {
    const el = document.createElement("p")
    if (b.line) el.dataset.line = String(b.line)
    Object.defineProperty(el, "offsetTop", { value: b.top })
    Object.defineProperty(el, "offsetHeight", { value: b.h })
    body.appendChild(el)
  }
  const scroller = { scrollTop } as HTMLElement
  return { body, scroller }
}

describe("topBlock", () => {
  it("finds the block in view and how far into it", () => {
    const { body, scroller } = view(
      [
        { line: 1, top: 0, h: 100 },
        { line: 5, top: 100, h: 100 },
      ],
      130,
    )
    expect(topBlock(scroller, body)).toEqual({ line: 5, off: 30 })
  })

  it("inside a block with no line (math, raw HTML), keeps the lined one above", () => {
    const { body, scroller } = view(
      [
        { line: 1, top: 0, h: 100 },
        { top: 100, h: 900 },
      ],
      600,
    )
    expect(topBlock(scroller, body)).toEqual({ line: 1, off: 600 })
  })
})

describe("blockAt", () => {
  it("is the last block starting at or before the line", () => {
    const { body } = view(
      [
        { line: 1, top: 0, h: 1 },
        { line: 5, top: 1, h: 1 },
        { line: 9, top: 2, h: 1 },
      ],
      0,
    )
    expect(blockAt(body, 7)!.dataset.line).toBe("5")
    expect(blockAt(body, 9)!.dataset.line).toBe("9")
  })
})
