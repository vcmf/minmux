import { describe, it, expect } from "vitest"
import { hintDue, launchedAgent } from "./agent-hint"

describe("launchedAgent", () => {
  it("reads our launch marker and nothing else", () => {
    expect(launchedAgent("agent;codex")).toBe("codex")
    expect(launchedAgent("agent;vim")).toBeNull()
    expect(launchedAgent("agent;constructor")).toBeNull()
    expect(launchedAgent("codex")).toBeNull()
  })
})

describe("hintDue", () => {
  it("shows when the agent runs and none of its hooks came since it started", () => {
    expect(hintDue({ launchedAt: 100, running: true })).toBe(true)
    expect(hintDue({ launchedAt: 100, lastEventAt: 50, running: true })).toBe(true) // an older run's
  })
  it("doesn't once a hook arrived, or the agent already exited", () => {
    expect(hintDue({ launchedAt: 100, lastEventAt: 150, running: true })).toBe(false)
    expect(hintDue({ launchedAt: 100, running: false })).toBe(false)
  })
})
