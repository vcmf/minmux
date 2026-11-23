import { describe, expect, it } from "vitest"
import { blockAt, blockOf, topBlock } from "./markdown-scroll"

// Blocks laid out at the given tops and heights (jsdom has no layout).
function view(
  blocks: { line?: number; top: number; h: number; text?: string }[],
  scrollTop: number,
) {
  const body = document.createElement("div")
  for (const b of blocks) {
    const el = document.createElement("p")
    if (b.line) el.dataset.line = String(b.line)
    el.textContent = b.text ?? ""
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
    expect(topBlock(scroller, body)).toMatchObject({ line: 5, off: 30 })
  })

  it("inside a block with no line (math, raw HTML), keeps the lined one above", () => {
    const { body, scroller } = view(
      [
        { line: 1, top: 0, h: 100 },
        { top: 100, h: 900 },
      ],
      600,
    )
    expect(topBlock(scroller, body)).toMatchObject({ line: 1, off: 600 })
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

describe("blockOf", () => {
  it("finds the block by its text when lines moved (text added above)", () => {
    const { body } = view(
      [
        { line: 1, top: 0, h: 1, text: "new" },
        { line: 43, top: 1, h: 1, text: "intro" },
        { line: 47, top: 2, h: 1, text: "reading this" },
      ],
      0,
    )
    expect(blockOf(body, { line: 5, off: 0, text: "reading this" })!.dataset.line).toBe("47")
    expect(blockOf(body, { line: 44, off: 0, text: "changed" })!.dataset.line).toBe("43")
  })

  it("is the same node when it's still there (a patch kept it)", () => {
    const { body } = view([{ line: 9, top: 0, h: 1, text: "same" }], 0)
    const el = body.children[0] as HTMLElement
    expect(blockOf(body, { line: 1, off: 0, text: "other", el })).toBe(el)
  })
})
