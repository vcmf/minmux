// What the Fleet panel lists for a session's MCP servers and skills (docs/design/FLEET_GRAPH.md,
// "Side panel"): used first (most calls first), then the ones that failed, then loaded but
// unused. Pure.
import type { Toolbox } from "./agent-graph"

export interface ToolRow {
  name: string
  uses: number // calls (MCP) or loads (skills)
  failed?: number // MCP calls that failed
  down?: boolean // the server failed to start
}

export interface ToolList {
  used: ToolRow[] // used, most first; then the down ones
  unused: string[] // loaded, never used
  total?: number // how many it had loaded (undefined: unknown)
}

const byUse = (a: ToolRow, b: ToolRow) => b.uses - a.uses || a.name.localeCompare(b.name)

/** A session's MCP servers, for the panel. */
export function mcpList(tb: Toolbox): ToolList {
  const down = new Set(tb.mcpDown ?? [])
  const names = new Set([...Object.keys(tb.mcp), ...Object.keys(tb.mcpFailed ?? {})])
  const used = [...names]
    .map((name) => ({
      name,
      uses: tb.mcp[name] ?? 0,
      ...(tb.mcpFailed?.[name] ? { failed: tb.mcpFailed[name] } : {}),
    }))
    .sort(byUse)
  const known = new Set([...names, ...down])
  const unused = (tb.mcpLoaded ?? []).filter((s) => !known.has(s)).sort()
  const downRows = [...down]
    .filter((s) => !names.has(s))
    .sort()
    .map((name) => ({ name, uses: 0, down: true }))
  const all = new Set([...(tb.mcpLoaded ?? []), ...known])
  return { used: [...used, ...downRows], unused, ...(tb.mcpLoaded ? { total: all.size } : {}) }
}

/** A session's skills, for the panel (null: not supported for this agent). */
export function skillList(tb: Toolbox): ToolList | null {
  if (!tb.skills) return null
  const used = Object.entries(tb.skills)
    .filter(([, n]) => n > 0)
    .map(([name, uses]) => ({ name, uses }))
    .sort(byUse)
  const usedNames = new Set(used.map((r) => r.name))
  const unused = (tb.skillsLoaded ?? []).filter((s) => !usedNames.has(s)).sort()
  const all = new Set([...(tb.skillsLoaded ?? []), ...usedNames])
  return { used, unused, ...(tb.skillsLoaded ? { total: all.size } : {}) }
}
