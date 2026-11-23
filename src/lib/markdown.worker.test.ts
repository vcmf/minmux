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
    const out = (posted[0] as { out: { blocks: { html: string; line: number }[] } }).out
    expect(out.blocks).toEqual([{ html: expect.stringContaining("<h1") as string, line: 1 }])
    vi.unstubAllGlobals()
  })
})
