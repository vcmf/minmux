import { describe, it, expect, vi } from "vitest"

describe("markdown worker", () => {
  it("answers with the rendered document", async () => {
    const posted: unknown[] = []
    vi.stubGlobal("postMessage", (m: unknown) => posted.push(m))
    vi.resetModules()
    await import("./markdown.worker")
    const handle = (self as unknown as { onmessage: (e: MessageEvent) => Promise<void> }).onmessage
    await handle({ data: { id: 7, text: "# Hi" } } as MessageEvent)
    expect(posted[0]).toMatchObject({ id: 7, out: { math: false } })
    expect((posted[0] as { out: { html: string } }).out.html).toContain("<h1")
    vi.unstubAllGlobals()
  })
})
