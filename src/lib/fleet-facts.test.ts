import { describe, it, expect } from "vitest"
import { contextWindow, folderName, kTokens, shortModel } from "./fleet-facts"

describe("fleet-facts", () => {
  it("a folder's name, a model's short name, tokens short", () => {
    expect(folderName("/Users/x/workspace/rts/")).toBe("rts")
    expect(folderName(undefined)).toBeUndefined()
    expect(shortModel("claude", "claude-opus-4-5-20251101")).toBe("opus-4-5")
    expect(shortModel("opencode", "openai/gpt-6.1-sol")).toBe("gpt-6.1-sol")
    expect(shortModel("codex", "gpt-6.1")).toBe("gpt-6.1")
    expect(shortModel("claude", undefined)).toBeUndefined()
    expect([kTokens(300), kTokens(71_400), kTokens(999_700), kTokens(1_250_000)]).toEqual([
      "300",
      "71k",
      "1M",
      "1.3M",
    ])
  })

  it("a context window: the agent's own, else its kind's usual one (a guess), else none", () => {
    expect(contextWindow("codex", { context: 5, output: 0, window: 272_000 })).toEqual({
      size: 272_000,
      guess: false,
    })
    expect(contextWindow("claude", { context: 71_000, output: 0 })).toEqual({
      size: 200_000,
      guess: true,
    })
    expect(contextWindow("claude", { context: 300_000, output: 0 })!.size).toBe(1_000_000)
    expect(contextWindow("opencode", { context: 5, output: 0 })).toBeUndefined()
    expect(contextWindow("claude", undefined)).toBeUndefined()
  })
})
