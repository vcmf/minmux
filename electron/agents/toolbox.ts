// A session's MCP servers and skills, folded from its agent's own records (docs/design/
// FLEET_GRAPH.md, "MCP servers and skills"). Each agent folds its lines into a Kit (copied only
// when a line changes it: the empty kit is shared); main turns it into the neutral Toolbox.
import type { Toolbox } from "../../src/lib/agent-graph"

export interface Kit {
  mcp: Record<string, number> // server → calls
  mcpFailed: Record<string, number> // server → failed calls
  mcpTools: Record<string, string[]> // server → the tools it lists now (loaded while any)
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
const MAX_KEYS = 256 // (records are untrusted: a map or list never grows past this)

/** A name from untrusted JSON: a non-empty string, bounded; else undefined. */
export const kitName = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim() ? v.trim().slice(0, MAX_NAME) : undefined

/** `m` with `k` counted `by` more (the same map when it's full and `k` is new). */
export function bump(m: Record<string, number>, k: string, by = 1): Record<string, number> {
  if (!(k in m) && Object.keys(m).length >= MAX_KEYS) return m
  return { ...m, [k]: Math.max(0, (m[k] ?? 0) + by) }
}

/** `m` with `tool` added to (or taken from) `server`'s tools; the same map when nothing changes. */
export function withTool(
  m: Record<string, string[]>,
  server: string,
  tool: string,
  add: boolean,
): Record<string, string[]> {
  const had = m[server] ?? []
  if (had.includes(tool) === add) return m
  if (add && (had.length >= MAX_KEYS || (!m[server] && Object.keys(m).length >= MAX_KEYS))) return m
  return { ...m, [server]: add ? [...had, tool] : had.filter((t) => t !== tool) }
}

/** Names, deduped and bounded. */
export const nameList = (xs: Iterable<string>): string[] => [...new Set(xs)].slice(0, MAX_KEYS)

/** A server's name as agents write it into tool names (anything but [A-Za-z0-9_-] → `_`). */
export const wireName = (name: string) => name.replace(/[^A-Za-z0-9_-]/g, "_")

/** Two kits' uses added up (a session's own, and its sub-agents'). */
export function addUses(a: Kit, b: Kit | undefined): Kit {
  if (!b) return a
  const sum = (x: Record<string, number>, y: Record<string, number>) => {
    let out = x
    for (const [k, n] of Object.entries(y)) out = bump(out, k, n)
    return out
  }
  return {
    ...a,
    mcp: sum(a.mcp, b.mcp),
    mcpFailed: sum(a.mcpFailed, b.mcpFailed),
    skills: sum(a.skills, b.skills),
  }
}

/** The Toolbox for a kit. `configured`: the servers the agent's config gives it (undefined: not
 *  read); a server seen in tool names under its wire name is shown by its configured name.
 *  `skills: false`: this agent's skills aren't supported yet. */
export function toToolbox(kit: Kit, configured?: string[], skills = true): Toolbox {
  const alias = new Map((configured ?? []).map((c) => [wireName(c), c]))
  const named = <V>(m: Record<string, V>): Record<string, V> => {
    const out: Record<string, V> = {}
    for (const [k, v] of Object.entries(m)) out[alias.get(k) ?? k] = v
    return out
  }
  const listed = Object.keys(kit.mcpTools)
    .filter((s) => kit.mcpTools[s]!.length)
    .map((s) => alias.get(s) ?? s)
  const loaded =
    configured || listed.length ? nameList([...listed, ...(configured ?? [])]) : undefined
  return {
    mcp: named(kit.mcp),
    ...(Object.keys(kit.mcpFailed).length ? { mcpFailed: named(kit.mcpFailed) } : {}),
    ...(loaded ? { mcpLoaded: loaded } : {}),
    ...(kit.mcpDown?.length ? { mcpDown: kit.mcpDown } : {}),
    skills: skills ? kit.skills : null,
    ...(skills && kit.skillsLoaded ? { skillsLoaded: kit.skillsLoaded } : {}),
  }
}

/** Keeps a session's snapshots in order: reads of the same session can finish out of order
 *  (a config read takes longer one time than the next), and an older one must not land last. */
export class Tickets {
  private next = new Map<string, number>()
  private sent = new Map<string, number>()
  /** A ticket for a read starting now. */
  take(session: string): number {
    const n = (this.next.get(session) ?? 0) + 1
    if (!this.next.has(session) && this.next.size >= MAX_KEYS) {
      const old = this.next.keys().next().value!
      this.next.delete(old)
      this.sent.delete(old)
    }
    this.next.set(session, n)
    return n
  }
  /** May this ticket's result go out (nothing newer went first)? Marks it sent. */
  send(session: string, ticket: number): boolean {
    if (ticket < (this.sent.get(session) ?? 0)) return false
    this.sent.set(session, ticket)
    return true
  }
  forget(session: string) {
    this.next.delete(session)
    this.sent.delete(session)
  }
}

/** Per session, the uses its finished sub-agents made (their transcripts are read once, when
 *  they stop): added into the session's next snapshot. */
export class SubUses {
  private kits = new Map<string, Kit>()
  add(session: string, kit: Kit) {
    if (!this.kits.has(session) && this.kits.size >= MAX_KEYS)
      this.kits.delete(this.kits.keys().next().value!)
    this.kits.set(session, addUses(this.kits.get(session) ?? emptyKit, kit))
  }
  of = (session: string): Kit | undefined => this.kits.get(session)
  forget(session: string) {
    this.kits.delete(session)
  }
}
