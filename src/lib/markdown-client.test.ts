import { describe, it, expect, vi, afterEach } from "vitest"

// A worker that renders (through the real renderer), or crashes, or never answers.
let mode: "ok" | "crash" | "hang" = "ok"
let spawned = 0
class FakeWorker {
  onmessage: ((e: MessageEvent) => void) | null = null
  onerror: (() => void) | null = null
  onmessageerror: (() => void) | null = null
  constructor() {
    spawned++
  }
  postMessage(m: { id: number; text: string }) {
    if (mode === "crash") return void setTimeout(() => this.onerror?.(), 0)
    if (mode === "hang") return
    void import("./markdown").then(async ({ renderMarkdown }) => {
      const out = await renderMarkdown(m.text)
      this.onmessage?.({ data: { id: m.id, out } } as MessageEvent)
    })
  }
  terminate() {}
}

async function client() {
  vi.stubGlobal("Worker", FakeWorker)
  vi.resetModules()
  return import("./markdown-client")
}

describe("renderMarkdownText", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
    mode = "ok"
    spawned = 0
  })

  it("renders in the worker and keeps the result for the same text", async () => {
    const c = await client()
    const r = await c.renderMarkdownText("# One")
    expect(r!.html).toContain("<h1")
    expect(c.renderedNow("# One")).toBe(r)
    expect(await c.renderMarkdownText("# One")).toBe(r) // from what's kept
    for (let i = 0; i < 9; i++) await c.renderMarkdownText(`text ${i}`)
    expect(c.renderedNow("# One")).toBeUndefined() // the oldest went
  })

  it("a crashed worker gives null (the source shows), respawned a few times, never this thread", async () => {
    mode = "crash"
    const c = await client()
    for (let i = 0; i < 5; i++) expect(await c.renderMarkdownText(`# ${i}`)).toBeNull()
    expect(spawned).toBe(3)
  })

  it("a render stuck in the worker times out", async () => {
    vi.useFakeTimers()
    mode = "hang"
    const c = await client()
    const r = c.renderMarkdownText("# stuck")
    await vi.advanceTimersByTimeAsync(10_000)
    expect(await r).toBeNull()
  })

  it("loads KaTeX's stylesheet once", async () => {
    const c = await client()
    expect(c.mathStyleReady()).toBe(false)
    await c.loadMathStyle()
    expect(c.mathStyleReady()).toBe(true)
  })
})
