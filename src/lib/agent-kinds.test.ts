import { describe, it, expect } from "vitest"
import { AVAILABLE_AGENTS, agentsOn, launchCommand } from "./agent-kinds"

describe("agentsOn", () => {
  it("offers every available agent on macOS/Linux, and hides Codex on Windows for now", () => {
    expect(agentsOn("darwin")).toEqual(AVAILABLE_AGENTS)
    expect(agentsOn("linux")).toEqual(AVAILABLE_AGENTS)
    expect(agentsOn("win32")).toContain("claude")
    expect(agentsOn("win32")).not.toContain("codex")
    expect(agentsOn("")).toEqual(agentsOn("win32")) // not known yet: nothing Windows can't run
  })
})

describe("launchCommand", () => {
  it("types the agent's command on PATH, else its path (quoted only when it has to be)", () => {
    expect(launchCommand({ kind: "codex" })).toBe("codex")
    expect(launchCommand({ kind: "claude", path: "/home/u/.claude/local/claude" })).toBe(
      "/home/u/.claude/local/claude",
    )
    expect(launchCommand({ kind: "claude", path: "/Users/a b/it's/claude" })).toBe(
      "'/Users/a b/it'\\''s/claude'",
    )
  })
})
