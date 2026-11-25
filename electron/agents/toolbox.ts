// A session's MCP servers and skills, folded from its agent's own records (docs/design/
// FLEET_GRAPH.md, "MCP servers and skills"). Each agent folds its lines into a Kit (copied only
// when a line changes it: the empty kit is shared); main turns it into the neutral Toolbox.
import type { Toolbox } from "../../src/lib/agent-graph"

export interface Kit {
  mcp: Record<string, number> // server → calls
  mcpFailed: Record<string, number> // server → failed calls
  mcpTools: Record<string, number> // server → tools it lists now (loaded while > 0)
  mcpDown: string[] | undefined // servers that failed to start (latest word)
  skills: Record<string, number> // skill → uses
  skillsLoaded: string[] | undefined // undefined: never listed
}

export const emptyKit: Kit = Object.freeze({
  mcp: {},
  mcpFailed: {},
  mcpTools: {},
  mcpDown: undefined,
  skills: {},
  skillsLoaded: undefined,
}) as Kit

const MAX_NAME = 128
const MAX_KEYS = 256 // (records are untrusted: a map never grows past this)

/** A name from untrusted JSON: a non-empty string, bounded; else undefined. */
export const kitName = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim() ? v.trim().slice(0, MAX_NAME) : undefined

/** `m` with `k` counted `by` more (the same map when it's full and `k` is new). */
export function bump(m: Record<string, number>, k: string, by = 1): Record<string, number> {
  if (!(k in m) && Object.keys(m).length >= MAX_KEYS) return m
  return { ...m, [k]: Math.max(0, (m[k] ?? 0) + by) }
}

/** Names, deduped and bounded. */
export const nameList = (xs: Iterable<string>): string[] => [...new Set(xs)].slice(0, MAX_KEYS)

/** The Toolbox for a kit. `configured`: the servers the agent's config lists (undefined: not
 *  read); `skills: false`: this agent's skills aren't supported yet. */
export function toToolbox(kit: Kit, configured?: string[], skills = true): Toolbox {
  const listed = Object.keys(kit.mcpTools).filter((s) => (kit.mcpTools[s] ?? 0) > 0)
  const loaded =
    configured || listed.length ? nameList([...listed, ...(configured ?? [])]) : undefined
  return {
    mcp: kit.mcp,
    ...(Object.keys(kit.mcpFailed).length ? { mcpFailed: kit.mcpFailed } : {}),
    ...(loaded ? { mcpLoaded: loaded } : {}),
    ...(kit.mcpDown?.length ? { mcpDown: kit.mcpDown } : {}),
    skills: skills ? kit.skills : null,
    ...(skills && kit.skillsLoaded ? { skillsLoaded: kit.skillsLoaded } : {}),
  }
}
