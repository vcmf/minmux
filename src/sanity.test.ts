import { describe, it, expect } from "vitest"

// Harness smoke test — confirms Vitest + jsdom are wired up.
// Replace/expand with real store + parser tests in M1 (see docs/TESTING.md §4).
describe("test harness", () => {
  it("runs in a jsdom DOM environment", () => {
    const el = document.createElement("div")
    el.textContent = "minmux"
    expect(el.textContent).toBe("minmux")
  })
})
