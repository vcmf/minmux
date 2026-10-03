import { describe, it, expect } from "vitest"
import { formatTokens, tokenBreakdown } from "./tokens"

describe("formatTokens", () => {
  it("formats across magnitudes", () => {
    expect(formatTokens(0)).toBe("0")
    expect(formatTokens(999)).toBe("999")
    expect(formatTokens(1200)).toBe("1.2k")
    expect(formatTokens(15000)).toBe("15k")
    expect(formatTokens(1_500_000)).toBe("1.5M")
    expect(formatTokens(42_000_000)).toBe("42M")
  })
})

describe("tokenBreakdown", () => {
  it("labels context and generated output", () => {
    expect(tokenBreakdown({ context: 148_000, output: 7_400_000 })).toBe(
      "↑ 148k context · ↓ 7.4M generated",
    )
  })
})

describe("tokenBreakdown with the model's context window (Codex)", () => {
  it("says how full the window is", () => {
    expect(tokenBreakdown({ context: 129200, output: 900, window: 258400 })).toBe(
      "↑ 129k context (50% of 258k) · ↓ 900 generated",
    )
  })
})
