import { describe, it, expect } from "vitest"
import { mcpList, skillList } from "./fleet-toolbox"

describe("fleet-toolbox", () => {
  it("MCP: used by calls, failed calls kept, down servers, then the unused", () => {
    const l = mcpList({
      mcp: { notion: 3, gh: 1 },
      mcpFailed: { gh: 2, echo: 1 },
      mcpLoaded: ["notion", "gh", "hexgate", "zeta"],
      mcpDown: ["hexgate"],
      skills: {},
    })
    expect(l.used).toEqual([
      { name: "notion", uses: 3 },
      { name: "gh", uses: 1, failed: 2 },
      { name: "echo", uses: 0, failed: 1 },
      { name: "hexgate", uses: 0, down: true },
    ])
    expect(l.unused).toEqual(["zeta"])
    expect(l.total).toBe(5)
    expect(mcpList({ mcp: {}, skills: {} }).total).toBeUndefined() // never listed: unknown
  })

  it("skills: used most first, then the loaded ones; null when not supported", () => {
    const l = skillList({
      mcp: {},
      skills: { run: 2, review: 1, x: 0 },
      skillsLoaded: ["review", "run", "deploy"],
    })
    expect(l).toEqual({
      used: [
        { name: "run", uses: 2 },
        { name: "review", uses: 1 },
      ],
      unused: ["deploy"],
      total: 3,
    })
    expect(skillList({ mcp: {}, skills: null })).toBeNull()
  })

  it("one call, a down server already used, nothing loaded", () => {
    const l = mcpList({ mcp: { a: 1 }, mcpDown: ["a"], skills: {} })
    expect(l.used).toEqual([{ name: "a", uses: 1 }])
    expect(skillList({ mcp: {}, skills: { s: 1 } })).toEqual({
      used: [{ name: "s", uses: 1 }],
      unused: [],
    })
  })
})
