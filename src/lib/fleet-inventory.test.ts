import { describe, it, expect } from "vitest"
import {
  dayBefore,
  liveToolbox,
  localDay,
  usedBy,
  windowToolbox,
  type InventoryAgent,
} from "./fleet-inventory"
import type { FleetAgent } from "./fleet-model"

const today = new Date(2026, 10, 25, 12)
const hist: InventoryAgent = {
  days: {
    "2026-11-25": { mcp: { gh: 2 }, skills: { r: 1 } },
    "2026-11-19": { mcp: { gh: 1 }, mcpFailed: { db: 1 }, skills: {} },
    "2026-10-01": { mcp: { old: 4 }, skills: { r: 2 } },
  },
  loaded: {
    "2026-11-24": { mcp: ["gh", "db"], skills: ["r"] },
    "2026-10-01": { mcp: ["old"], skills: ["ancient"] },
  },
  mcpNow: ["idle"],
  skillsNow: ["s"],
}
const agent = (id: string, toolbox: FleetAgent["toolbox"], kind: FleetAgent["kind"] = "claude") =>
  ({ id, sessionId: id, paneId: "p", kind, status: "idle", subs: [], toolbox }) as FleetAgent

describe("fleet-inventory", () => {
  it("a day is the user's local one, zero-padded", () => {
    expect(localDay(new Date(2026, 0, 5, 23, 59).getTime())).toBe("2026-01-05")
  })

  it("days before today", () => {
    expect(dayBefore(today, 0)).toBe("2026-11-25")
    expect(dayBefore(today, 6)).toBe("2026-11-19")
  })

  it("a window adds up its days; All adds them all", () => {
    expect(windowToolbox(hist, "7d", today)).toEqual({
      mcp: { gh: 3 },
      mcpFailed: { db: 1 },
      mcpLoaded: ["idle", "gh", "db"], // (not "old": loaded only long ago)
      skills: { r: 1 },
      skillsLoaded: ["s", "r"],
    })
    const all = windowToolbox(hist, "all", today)
    expect([all.mcp, all.mcpLoaded]).toEqual([{ gh: 3, old: 4 }, ["idle", "gh", "db", "old"]])
    const codex = windowToolbox({ ...hist, skillsNow: null }, "30d", today)
    expect([codex.skills, codex.skillsLoaded]).toEqual([null, undefined])
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
