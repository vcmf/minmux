// The Fleet inventory (docs/design/FLEET_GRAPH.md, step 6): per agent kind, each MCP server and
// skill with its use count over a window, then the loaded but unused ones. The windows past
// Live come from main's history scan as day buckets; Live adds up the open sessions. Pure.
import type { AgentKind, Toolbox } from "./agent-graph"
import type { FleetAgent } from "./fleet-model"

/** Uses on one day (or over a window). */
export interface Uses {
  mcp: Record<string, number>
  mcpFailed?: Record<string, number>
  skills: Record<string, number>
}

/** One agent kind's history: its uses per day (`YYYY-MM-DD`), what its sessions had loaded per
 *  day, and what its config gives it now. */
export interface InventoryAgent {
  days: Record<string, Uses>
  loaded: Record<string, { mcp: string[]; skills: string[] }>
  mcpNow: string[]
  skillsNow: string[] | null // null: skills not supported (Codex)
}

/** The history scan's answer. */
export type Inventory = Partial<Record<AgentKind, InventoryAgent>>

export type InventoryWindow = "live" | "7d" | "30d" | "all"

export const WINDOW_DAYS: Record<Exclude<InventoryWindow, "live" | "all">, number> = {
  "7d": 7,
  "30d": 30,
}

/** A day `n` days before `today` (`YYYY-MM-DD`, UTC like the agents' timestamps). */
export function dayBefore(today: Date, n: number): string {
  return new Date(today.getTime() - n * 86_400_000).toISOString().slice(0, 10)
}

const add = (into: Record<string, number>, from: Record<string, number> | undefined) => {
  for (const [k, n] of Object.entries(from ?? {})) into[k] = (into[k] ?? 0) + n
}

/** One kind's totals over a window, as a Toolbox (the panel's lists read it). */
export function windowToolbox(
  a: InventoryAgent,
  window: Exclude<InventoryWindow, "live">,
  today: Date,
): Toolbox {
  const from = window === "all" ? "" : dayBefore(today, WINDOW_DAYS[window] - 1)
  const mcp: Record<string, number> = {}
  const mcpFailed: Record<string, number> = {}
  const skills: Record<string, number> = {}
  for (const [day, u] of Object.entries(a.days)) {
    if (day < from) continue
    add(mcp, u.mcp)
    add(mcpFailed, u.mcpFailed)
    add(skills, u.skills)
  }
  // Loaded: what the window's sessions had, and what the config gives now (one removed long
  // ago isn't this week's "unused").
  const mcpLoaded = new Set(a.mcpNow)
  const skillsLoaded = new Set(a.skillsNow ?? [])
  for (const [day, l] of Object.entries(a.loaded)) {
    if (day < from) continue
    for (const s of l.mcp) mcpLoaded.add(s)
    for (const s of l.skills) skillsLoaded.add(s)
  }
  return {
    mcp,
    ...(Object.keys(mcpFailed).length ? { mcpFailed } : {}),
    mcpLoaded: [...mcpLoaded],
    skills: a.skillsNow === null ? null : skills,
    ...(a.skillsNow === null ? {} : { skillsLoaded: [...skillsLoaded] }),
  }
}

/** One kind's totals over its open sessions (their toolboxes added up). */
export function liveToolbox(agents: FleetAgent[], kind: AgentKind): Toolbox | undefined {
  const mine = agents.filter((a) => a.kind === kind && a.toolbox)
  if (!mine.length) return undefined
  const mcp: Record<string, number> = {}
  const mcpFailed: Record<string, number> = {}
  const skills: Record<string, number> = {}
  const mcpLoaded = new Set<string>()
  const skillsLoaded = new Set<string>()
  let skillsKnown = true
  let mcpKnown = false
  let skillsListed = false
  for (const a of mine) {
    const t = a.toolbox!
    add(mcp, t.mcp)
    add(mcpFailed, t.mcpFailed)
    if (t.mcpLoaded) {
      mcpKnown = true
      for (const s of t.mcpLoaded) mcpLoaded.add(s)
    }
    if (t.skills === null) skillsKnown = false
    else add(skills, t.skills)
    if (t.skillsLoaded) {
      skillsListed = true
      for (const s of t.skillsLoaded) skillsLoaded.add(s)
    }
  }
  return {
    mcp,
    ...(Object.keys(mcpFailed).length ? { mcpFailed } : {}),
    ...(mcpKnown ? { mcpLoaded: [...mcpLoaded] } : {}),
    skills: skillsKnown ? skills : null,
    ...(skillsKnown && skillsListed ? { skillsLoaded: [...skillsLoaded] } : {}),
  }
}

/** The open sessions that used an MCP server or a skill (for the graph to highlight). */
export function usedBy(
  agents: FleetAgent[],
  kind: AgentKind,
  what: "mcp" | "skill",
  name: string,
): string[] {
  return agents
    .filter((a) => {
      if (a.kind !== kind || !a.toolbox) return false
      const t = a.toolbox
      return what === "mcp"
        ? (t.mcp[name] ?? 0) + (t.mcpFailed?.[name] ?? 0) > 0
        : (t.skills?.[name] ?? 0) > 0
    })
    .map((a) => a.id)
}
