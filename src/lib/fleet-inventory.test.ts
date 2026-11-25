import { describe, it, expect } from "vitest"
import {
  dayBefore,
  liveToolbox,
  usedBy,
  windowToolbox,
  type InventoryAgent,
} from "./fleet-inventory"
import type { FleetAgent } from "./fleet-model"

const today = new Date("2026-11-25T12:00:00Z")
const hist: InventoryAgent = {
  days: {
    "2026-11-25": { mcp: { gh: 2 }, skills: { r: 1 } },
    "2026-11-19": { mcp: { gh: 1 }, mcpFailed: { db: 1 }, skills: {} },
    "2026-10-01": { mcp: { old: 4 }, skills: { r: 2 } },
  },
  mcpLoaded: ["gh", "db", "old", "idle"],
  skillsLoaded: ["r", "s"],
}
const agent = (id: string, toolbox: FleetAgent["toolbox"], kind: FleetAgent["kind"] = "claude") =>
  ({ id, sessionId: id, paneId: "p", kind, status: "idle", subs: [], toolbox }) as FleetAgent

describe("fleet-inventory", () => {
  it("days before today", () => {
    expect(dayBefore(today, 0)).toBe("2026-11-25")
    expect(dayBefore(today, 6)).toBe("2026-11-19")
  })

  it("a window adds up its days; All adds them all", () => {
    expect(windowToolbox(hist, "7d", today)).toEqual({
      mcp: { gh: 3 },
      mcpFailed: { db: 1 },
      mcpLoaded: ["gh", "db", "old", "idle"],
      skills: { r: 1 },
      skillsLoaded: ["r", "s"],
    })
    expect(windowToolbox(hist, "all", today).mcp).toEqual({ gh: 3, old: 4 })
    expect(windowToolbox({ ...hist, skillsLoaded: null }, "30d", today).skills).toBeNull()
  })

  it("Live adds up the open sessions of a kind; who used what", () => {
    const agents = [
      agent("a", { mcp: { gh: 1 }, mcpLoaded: ["gh"], skills: { r: 1 }, skillsLoaded: ["r"] }),
      agent("b", { mcp: { gh: 2 }, mcpFailed: { x: 1 }, skills: {} }),
      agent("c", undefined),
      agent("d", { mcp: { e: 1 }, skills: null }, "codex"),
    ]
    expect(liveToolbox(agents, "claude")).toEqual({
      mcp: { gh: 3 },
      mcpFailed: { x: 1 },
      mcpLoaded: ["gh"],
      skills: { r: 1 },
      skillsLoaded: ["r"],
    })
    expect(liveToolbox(agents, "codex")!.skills).toBeNull()
    expect(liveToolbox(agents, "opencode")).toBeUndefined()
    expect(usedBy(agents, "claude", "mcp", "gh")).toEqual(["a", "b"])
    expect(usedBy(agents, "claude", "mcp", "x")).toEqual(["b"])
    expect(usedBy(agents, "claude", "skill", "r")).toEqual(["a"])
    expect(usedBy(agents, "codex", "skill", "r")).toEqual([])
  })
})
