import { describe, it, expect, vi, afterEach } from "vitest"
import { render, waitFor } from "@testing-library/react"

// A worker that crashes on every request: the block ends on the text, plainly.
class BrokenWorker {
  onmessage: ((e: MessageEvent) => void) | null = null
  onerror: (() => void) | null = null
  onmessageerror: (() => void) | null = null
  postMessage() {
    setTimeout(() => this.onerror?.(), 0)
  }
  terminate() {}
}

describe("MarkdownBlock", () => {
  afterEach(() => vi.unstubAllGlobals())

  it("shows the text plainly, as final, when it can't be rendered", async () => {
    vi.stubGlobal("Worker", BrokenWorker)
    vi.resetModules()
    const { MarkdownBlock } = await import("./markdown-block")
    const { container } = render(<MarkdownBlock text={"**a** <b>"} onLink={() => {}} />)
    await waitFor(() => expect(container.querySelector(".md-plain")).not.toBeNull())
    expect(container.querySelector(".md-pending")).toBeNull()
    expect(container.textContent).toBe("**a** <b>")
  })
})
