import { describe, expect, it, vi } from "vitest"

vi.mock("electron", () => ({ dialog: {}, utilityProcess: {} }))

const { autoPort } = await import("./remote-control")

describe("autoPort", () => {
  it("gives the app, a dev build and other profiles their own ports", () => {
    expect(autoPort("")).toBe(7420)
    expect(autoPort("dev")).toBe(7421)
    const p = autoPort("claude-verify")
    expect(p).toBeGreaterThanOrEqual(7430)
    expect(p).toBeLessThan(7490)
    expect(autoPort("claude-verify")).toBe(p)
  })
})
