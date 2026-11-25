// Each agent's history for the Fleet inventory (docs/design/FLEET_GRAPH.md, step 6), read in the
// sessions worker: which files hold its uses, how a line of them folds into uses per day
// (step 5's line readers), and what its config says it has. Agent specifics live here.
import fs from "node:fs"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"
import type { Uses } from "../../src/lib/fleet-inventory"
import { jsonlFiles, mapLimit } from "../history-read"
import type { DayAcc, InventorySource, StoreMark } from "../inventory-scan"
import { claudeHome } from "./claude-history"
import { ClaudeMcpConfig, addClaudeKitLine } from "./claude-toolbox"
import { codexHome, rollouts } from "./codex-history"
import { CodexMcpConfig, addCodexKitLine } from "./codex-toolbox"
import { opencodeDb } from "./opencode-history"
import { OpencodeConfig, opencodeServerOf } from "./opencode-toolbox"
import { emptyKit, kitName, type Kit } from "./toolbox"

// (the agents write ISO timestamps without spaces: the day is a timestamp's first 10 characters)
const DAY = /"timestamp":"(\d{4}-\d{2}-\d{2})/g

/** A line's own day: its record's `timestamp` (Claude writes it last, Codex first). */
export function lineDay(line: string, which: "first" | "last"): string | undefined {
  let day: string | undefined
  DAY.lastIndex = 0
  for (let m = DAY.exec(line); m; m = DAY.exec(line)) {
    day = m[1]
    if (which === "first") break
  }
  return day
}

/** A line folded with a step 5 line reader: what it adds goes to its day. */
export function dayFold(kitLine: (acc: Kit, line: string) => Kit, which: "first" | "last") {
  return (acc: DayAcc, line: string, fileDay: string): DayAcc => {
    const k = kitLine(emptyKit, line)
    if (k === emptyKit) return acc
    const day = lineDay(line, which) ?? fileDay
    const add = (into: Record<string, number>, from: Record<string, number>) => {
      for (const [n, c] of Object.entries(from)) into[n] = (into[n] ?? 0) + c
    }
    const hasUses =
      Object.keys(k.mcp).length || Object.keys(k.mcpFailed).length || Object.keys(k.skills).length
    if (hasUses) {
      const u = (acc.days[day] ??= { mcp: {}, skills: {} })
      add(u.mcp, k.mcp)
      if (Object.keys(k.mcpFailed).length) add((u.mcpFailed ??= {}), k.mcpFailed)
      add(u.skills, k.skills)
    }
    for (const s of Object.keys(k.mcpTools))
      if (!acc.mcpLoaded.includes(s) && acc.mcpLoaded.length < 512) acc.mcpLoaded.push(s)
    for (const s of k.skillsLoaded ?? [])
      if (!acc.skillsLoaded.includes(s) && acc.skillsLoaded.length < 512) acc.skillsLoaded.push(s)
    return acc
  }
}

/** Claude: every project's transcripts and their sub-agents' (`<id>/subagents/`). */
export function claudeInventory(
  root = claudeHome,
  config = new ClaudeMcpConfig(),
): InventorySource {
  return {
    kind: "claude",
    async files() {
      const projects = path.join(root(), "projects")
      let dirs: string[]
      try {
        dirs = await fs.promises.readdir(projects)
      } catch {
        return []
      }
      const out = await mapLimit(dirs, 8, async (d) => {
        const dir = path.join(projects, d)
        const top = await jsonlFiles(dir)
        const subs = await mapLimit(top, 8, (f) =>
          jsonlFiles(path.join(f.file.replace(/\.jsonl$/, ""), "subagents")),
        )
        return [...top, ...subs.flatMap((s) => s ?? [])]
      })
      return out.flatMap((f) => f ?? [])
    },
    line: dayFold(addClaudeKitLine, "last"),
    async loaded() {
      return { mcp: (await config.servers(undefined)) ?? [], skills: [] }
    },
  }
}

/** Codex: its rollouts, archived ones too. Skills: not supported yet. */
export function codexInventory(home = codexHome, config = new CodexMcpConfig()): InventorySource {
  return {
    kind: "codex",
    async files() {
      const [live, archived] = await Promise.all([
        rollouts(path.join(home(), "sessions")),
        jsonlFiles(path.join(home(), "archived_sessions")),
      ])
      return [...live, ...archived]
    },
    line: dayFold(addCodexKitLine, "first"),
    noSkills: true,
    async loaded() {
      return { mcp: (await config.servers(home())) ?? [], skills: null }
    },
  }
}

/** OpenCode: its tool calls (`part` rows), from a mark on; MCP tools are `<server>_<tool>`. */
export function opencodeInventory(db = opencodeDb, config = new OpencodeConfig()): InventorySource {
  return {
    kind: "opencode",
    files: async () => [],
    line: (acc) => acc,
    async loaded() {
      return {
        mcp: (await config.servers(undefined)) ?? [],
        skills: await config.skills(undefined),
      }
    },
    // The database's tool calls, kept raw (`<folder>\0<tool>` → calls) and made into servers
    // only when the result is built: one whose config can't be read now isn't lost.
    async store(after: StoreMark) {
      const file = db()
      if (!fs.existsSync(file)) return { until: after, days: {} }
      const days: Record<string, Uses> = {}
      const count = async (r: Row) => {
        const tool = kitName(r.tool)
        if (!tool || !Number.isFinite(r.t)) return // (a row without a sane time: not counted)
        const u = (days[new Date(r.t).toISOString().slice(0, 10)] ??= { mcp: {}, skills: {} })
        const ok = r.status === "completed"
        if (tool === "skill") {
          const n = kitName(r.name)
          if (n && ok) u.skills[n] = (u.skills[n] ?? 0) + 1
          return
        }
        if (!tool.includes("_")) return // (a built-in: an MCP tool is `<server>_<tool>`)
        // A server configured now is named now (kept, so a server removed later keeps its
        // counts); one not known yet stays raw, `<folder>\0<tool>`, for a later config to name.
        const server = opencodeServerOf(tool, (await config.servers(r.dir ?? undefined)) ?? [])
        const key = server ? `=${server}` : `${r.dir ?? ""}\0${tool}`
        const into = ok ? u.mcp : (u.mcpFailed ??= {})
        into[key] = (into[key] ?? 0) + 1
      }
      const final = (r: Row) => r.status === "completed" || r.status === "error"
      // (by part id: the primary key, and in time order; each page a short read)
      const SELECT = `select p.time_created t, p.id id, s.directory dir,
          json_extract(p.data, '$.type') type, json_extract(p.data, '$.tool') tool,
          json_extract(p.data, '$.state.status') status,
          json_extract(p.data, '$.state.input.name') name
        from part p left join session s on s.id = p.session_id`
      const read = (sql: string, ...args: (string | number)[]) => {
        const d = new DatabaseSync(file, { readOnly: true, timeout: 1000 })
        try {
          return d.prepare(sql).all(...args) as unknown as Row[]
        } finally {
          d.close()
        }
      }
      // Calls running at the last read: counted once they've finished, kept a day at most.
      const day = Date.now() - 24 * 60 * 60_000
      const pending: string[] = []
      const was = (after.pending ?? []).slice(-1000)
      if (was.length) {
        const rows = read(`${SELECT} where p.id in (${was.map(() => "?").join(",")})`, ...was)
        for (const r of rows)
          if (final(r)) await count(r)
          else if (r.t > day) pending.push(r.id)
      }
      // Ids come from each OpenCode's own clock: a row another process writes a moment late can
      // sort below the newest id read. So the last two minutes' ids are read from again (from
      // `floor`), the ones already read skipped.
      const recent = new Map(after.recent ?? [])
      let t = after.t
      let last = after.id
      let first = true
      let cursor = after.floor ?? after.id
      for (;;) {
        const rows = first
          ? read(
              `${SELECT} where p.id ${after.floor ? ">=" : ">"} ? order by p.id limit ${PAGE}`,
              cursor,
            )
          : read(`${SELECT} where p.id > ? order by p.id limit ${PAGE}`, cursor)
        first = false
        for (const r of rows) {
          cursor = r.id
          if (recent.has(r.id)) continue
          recent.set(r.id, Number.isFinite(r.t) ? r.t : t)
          if (Number.isFinite(r.t)) t = Math.max(t, r.t)
          if (r.id > last) last = r.id
          if (r.type !== "tool") continue
          if (final(r)) await count(r)
          else if (r.t > day) pending.push(r.id)
        }
        // (only the last two minutes are kept: memory stays small on a first read of it all)
        for (const [x, at] of recent) if (at < t - 2 * 60_000) recent.delete(x)
        if (rows.length < PAGE) break
        await new Promise((r) => setImmediate(r)) // (a page at a time: the worker answers others)
      }
      // The window for next time: the last two minutes' ids; the floor is the oldest kept (so
      // every id from it on is known: none counted twice).
      const since = t - 2 * 60_000
      const keep = [...recent]
        .filter(([, at]) => at >= since)
        .sort(([x], [y]) => (x < y ? -1 : 1))
        .slice(-5000)
      const floor = keep[0]?.[0]
      return {
        until: {
          t,
          id: last,
          pending: pending.slice(-1000),
          ...(floor ? { floor, recent: keep } : {}),
        },
        days,
      }
    },
    // Raw tool calls → MCP servers, as configured where each session ran.
    async resolve(raw) {
      const out: Record<string, Uses> = {}
      for (const [day, u] of Object.entries(raw)) {
        const o: Uses = { mcp: {}, skills: { ...u.skills } }
        for (const [field, from] of [
          ["mcp", u.mcp],
          ["mcpFailed", u.mcpFailed ?? {}],
        ] as const)
          for (const [key, n] of Object.entries(from)) {
            const at = key.indexOf("\0")
            const dir = at > 0 ? key.slice(0, at) : undefined
            // (named when read; else as configured now: a tool no config names isn't MCP)
            const s = key.startsWith("=")
              ? key.slice(1)
              : opencodeServerOf(key.slice(at + 1), (await config.servers(dir)) ?? [])
            if (!s) continue
            const into = field === "mcp" ? o.mcp : (o.mcpFailed ??= {})
            into[s] = (into[s] ?? 0) + n
          }
        if (Object.keys(o.mcp).length || o.mcpFailed || Object.keys(o.skills).length) out[day] = o
      }
      return out
    },
  }
}

const PAGE = 5000

interface Row {
  t: number
  id: string
  dir: string | null
  type?: unknown
  tool: unknown
  status: unknown
  name: unknown
}

/** The sources the sessions worker scans. */
export const inventorySources = (): InventorySource[] => [
  claudeInventory(),
  codexInventory(),
  opencodeInventory(),
]
