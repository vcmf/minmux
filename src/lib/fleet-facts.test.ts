import { describe, it, expect } from "vitest"
import { contextWindow, folderName, kTokens, shortModel } from "./fleet-facts"

describe("fleet-facts", () => {
  it("a folder's name, a model's short name, tokens in k", () => {
    expect(folderName("/Users/x/workspace/rts/")).toBe("rts")
    expect(folderName(undefined)).toBeUndefined()
    expect(shortModel("claude-opus-4-5-20251101")).toBe("opus-4-5")
    expect(shortModel("openai/gpt-6.1-sol")).toBe("gpt-6.1-sol")
    expect(shortModel(undefined)).toBeUndefined()
    expect([kTokens(71_400), kTokens(1_000_000), kTokens(1_250_000)]).toEqual(["71k", "1M", "1.3M"])
  })

  it("a context window: the agent's own, else Claude's 200k (1M past it), else unknown", () => {
    expect(contextWindow("codex", { context: 5, output: 0, window: 272_000 })).toBe(272_000)
    expect(contextWindow("claude", { context: 71_000, output: 0 })).toBe(200_000)
    expect(contextWindow("claude", { context: 300_000, output: 0 })).toBe(1_000_000)
    expect(contextWindow("claude", { context: 1, output: 0, model: "claude-opus-5[1m]" })).toBe(
      1_000_000,
    )
    expect(contextWindow("opencode", { context: 5, output: 0 })).toBeUndefined()
    expect(contextWindow("claude", undefined)).toBeUndefined()
  })
})
