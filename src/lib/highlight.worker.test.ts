import { describe, it, expect, vi } from "vitest"

describe("highlight worker", () => {
  it("answers with the text's lines: highlighted, or escaped when there's no language", async () => {
    const posted: unknown[] = []
    vi.stubGlobal("postMessage", (m: unknown) => posted.push(m))
    vi.resetModules()
    await import("./highlight.worker")
    const handle = (self as unknown as { onmessage: (e: MessageEvent) => Promise<void> }).onmessage
    await handle({ data: { id: 1, code: "const a = 1\nb", lang: "typescript" } } as MessageEvent)
    await handle({ data: { id: 2, code: "a < b", lang: null } } as MessageEvent)
    const [one, two] = posted as { id: number; lines: string[] }[]
    expect(one!.id).toBe(1)
    expect(one!.lines).toHaveLength(2)
    expect(one!.lines[0]).toContain("hljs-keyword")
    expect(two).toEqual({ id: 2, lines: ["a &lt; b"] })
    vi.unstubAllGlobals()
  })
})
