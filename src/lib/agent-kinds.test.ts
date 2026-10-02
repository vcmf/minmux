import { describe, it, expect } from "vitest"
import { AVAILABLE_AGENTS, agentsOn } from "./agent-kinds"

describe("agentsOn", () => {
  it("offers every available agent on macOS/Linux, and hides Codex on Windows for now", () => {
    expect(agentsOn("darwin")).toEqual(AVAILABLE_AGENTS)
    expect(agentsOn("linux")).toEqual(AVAILABLE_AGENTS)
    expect(agentsOn("win32")).toContain("claude")
    expect(agentsOn("win32")).not.toContain("codex")
    expect(agentsOn("")).toEqual(agentsOn("win32")) // not known yet: nothing Windows can't run
  })
})
