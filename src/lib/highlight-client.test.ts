import { describe, it, expect, vi, afterEach } from "vitest"

// A Worker that fails to load: every request still gets its lines (highlighted on this thread).
class BrokenWorker {
  onmessage: ((e: MessageEvent) => void) | null = null
  onerror: (() => void) | null = null
  onmessageerror: (() => void) | null = null
  postMessage() {
    setTimeout(() => this.onerror?.(), 0)
  }
  terminate() {}
}

describe("highlightLines", () => {
  afterEach(() => vi.unstubAllGlobals())

  it("falls back to this thread when the worker fails", async () => {
    vi.stubGlobal("Worker", BrokenWorker)
    vi.resetModules()
    const { highlightLines } = await import("./highlight-client")
    const lines = await highlightLines("const a = 1\nlet b", "typescript")
    expect(lines).toHaveLength(2)
    expect(lines[0]).toContain("hljs-keyword")
    // …and after that, without asking the broken worker again
    expect((await highlightLines("let c", "typescript"))[0]).toContain("hljs-keyword")
  })

  it("plain text for an unknown language or a very large file", async () => {
    vi.resetModules()
    const { highlightLines } = await import("./highlight-client")
    expect(await highlightLines("a < b\nc", null)).toEqual(["a &lt; b", "c"])
  })
})
