import { describe, it, expect } from "vitest"
import { emptyShown, patchBlocks } from "./markdown-patch"

const b = (html: string, line: number) => ({ html, line })
const lines = (body: HTMLElement) =>
  [...body.children].map((el) => `${el.textContent}@${(el as HTMLElement).dataset.line ?? "-"}`)

describe("patchBlocks", () => {
  it("writes every block the first time, each with its line", () => {
    const body = document.createElement("div")
    const shown = emptyShown()
    patchBlocks(body, shown, [b("<h1>T</h1>\n", 1), b("<p>a</p>\n", 3)])
    expect(lines(body)).toEqual(["T@1", "a@3"])
  })

  it("adds only the new block when text is added above; the rest keep their nodes", () => {
    const body = document.createElement("div")
    const shown = emptyShown()
    patchBlocks(body, shown, [b("<p>a</p>", 1), b("<p>b</p>", 3)])
    const [pa, pb] = [...body.children]
    const added = patchBlocks(body, shown, [
      b("<h2>new</h2>", 1),
      b("<p>a</p>", 3),
      b("<p>b</p>", 5),
    ])
    expect(lines(body)).toEqual(["new@1", "a@3", "b@5"]) // lines moved, nodes kept
    expect(body.children[1]).toBe(pa)
    expect(body.children[2]).toBe(pb)
    expect(added).toHaveLength(1)
  })

  it("replaces a changed block in the middle, removes a gone one, appends at the end", () => {
    const body = document.createElement("div")
    const shown = emptyShown()
    patchBlocks(body, shown, [b("<p>a</p>", 1), b("<p>b</p>", 3), b("<p>c</p>", 5)])
    const first = body.children[0]
    patchBlocks(body, shown, [b("<p>a</p>", 1), b("<p>B!</p>", 3), b("<p>c</p>", 5)])
    expect(lines(body)).toEqual(["a@1", "B!@3", "c@5"])
    expect(body.children[0]).toBe(first)
    patchBlocks(body, shown, [b("<p>a</p>", 1), b("<p>c</p>", 3)])
    expect(lines(body)).toEqual(["a@1", "c@3"])
    patchBlocks(body, shown, [b("<p>a</p>", 1), b("<p>c</p>", 3), b("<p>d</p>", 5)])
    expect(lines(body)).toEqual(["a@1", "c@3", "d@5"])
    patchBlocks(body, shown, [])
    expect(body.childNodes).toHaveLength(0)
  })

  it("a block that leaves a tag open doesn't take in the blocks after it", () => {
    const body = document.createElement("div")
    const shown = emptyShown()
    patchBlocks(body, shown, [b("<details><summary>s</summary>", 1), b("<p>after</p>", 3)])
    expect(body.children).toHaveLength(2)
    expect(body.children[1]!.textContent).toBe("after")
  })

  it("hands each removed block's nodes over, and marks a line only on a block starting with an element", () => {
    const body = document.createElement("div")
    const shown = emptyShown()
    patchBlocks(body, shown, [b("<p>a</p>", 1), b("text then <br>", 3)])
    expect((body.querySelector("br") as HTMLElement).dataset.line).toBeUndefined()
    const gone: Node[][] = []
    patchBlocks(body, shown, [b("<p>a</p>", 1)], (nodes) => gone.push(nodes))
    expect(gone).toHaveLength(1)
    expect(gone[0]!.some((n) => n.textContent?.includes("text then"))).toBe(true)
  })
})
