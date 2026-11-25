// Each agent's history for the Fleet inventory (docs/design/FLEET_GRAPH.md, step 6), read in the
// sessions worker: which files hold its uses, how a line of them folds into uses per day
// (step 5's line readers), and what its config says it has. Agent specifics live here.
import fs from "node:fs"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"
import type { Uses } from "../../src/lib/fleet-inventory"
import { jsonlFiles, mapLimit } from "../history-read"
import type { DayAcc, InventorySource, SessionEntry } from "../inventory-scan"
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
  // One finished tool call into its day: a skill by its name; an MCP call by its server as
  // configured where it ran, named now (kept: a server removed later keeps its counts), or
  // kept raw, `<folder>\0<tool>`, for a later config to name.
  const countCall = async (days: Record<string, Uses>, r: Row) => {
    const final = r.status === "completed" || r.status === "error"
    const tool = kitName(r.tool)
    if (!final || !tool || !Number.isFinite(r.t)) return
    const u = (days[new Date(r.t).toISOString().slice(0, 10)] ??= { mcp: {}, skills: {} })
    const ok = r.status === "completed"
    if (tool === "skill") {
      const n = kitName(r.name)
      if (n && ok) u.skills[n] = (u.skills[n] ?? 0) + 1
      return
    }
    if (!tool.includes("_")) return // (a built-in: an MCP tool is `<server>_<tool>`)
    const server = opencodeServerOf(tool, (await config.servers(r.dir ?? undefined)) ?? [])
    const key = server ? `=${server}` : `${r.dir ?? ""}\0${tool}`
    const into = ok ? u.mcp : (u.mcpFailed ??= {})
    into[key] = (into[key] ?? 0) + 1
  }
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
    // Each session's tool calls, recounted only when its fingerprint (how many parts, and the
    // last change to one, through the session index) moved: no reliance on id order or the
    // clock, and a call still running is counted once it finishes (its part changes).
    async sessions(known: Record<string, string>) {
      const file = db()
      const out: Record<string, SessionEntry> = {}
      if (!fs.existsSync(file)) return out
      const open = () => new DatabaseSync(file, { readOnly: true, timeout: 1000 })
      let list: { id: string; dir: string | null }[]
      const d0 = open()
      try {
        list = d0.prepare("select id, directory dir from session").all() as unknown as typeof list
      } finally {
        d0.close()
      }
      for (let i = 0; i < list.length; i += BATCH) {
        const d = open() // (never held open between batches: OpenCode keeps writing)
        try {
          const sig = d.prepare(
            "select count(*) n, max(time_updated) u from part where session_id = ?",
          )
          const parts = d.prepare(
            `select time_created t, json_extract(data, '$.tool') tool,
               json_extract(data, '$.state.status') status,
               json_extract(data, '$.state.input.name') name
             from part where session_id = ? and json_extract(data, '$.type') = 'tool'`,
          )
          for (const ses of list.slice(i, i + BATCH)) {
            const f = sig.get(ses.id) as { n: number; u: number | null } | undefined
            const now = `${f?.n ?? 0}:${f?.u ?? 0}`
            if (known[ses.id] === now) continue
            const days: Record<string, Uses> = {}
            for (const r of parts.all(ses.id) as unknown as Row[])
              await countCall(days, { ...r, dir: ses.dir })
            out[ses.id] = { sig: now, days }
          }
        } finally {
          d.close()
        }
        await new Promise((r) => setImmediate(r)) // (a batch at a time: the worker answers others)
      }
      return out
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

const BATCH = 200 // sessions per database read

interface Row {
  t: number
  dir: string | null
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
