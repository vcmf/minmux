// Each agent's history for the Fleet inventory (docs/design/FLEET_GRAPH.md, step 6), read in the
// sessions worker: which files hold its uses, how a line of them folds into uses per day
// (step 5's line readers), and what its config says it has. Agent specifics live here.
import fs from "node:fs"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"
import type { Uses } from "../../src/lib/fleet-inventory"
import { jsonlFiles, mapLimit } from "../history-read"
import type { DayAcc, InventorySource } from "../inventory-scan"
import { claudeHome } from "./claude-history"
import { ClaudeMcpConfig, addClaudeKitLine } from "./claude-toolbox"
import { codexHome, rollouts } from "./codex-history"
import { CodexMcpConfig, addCodexKitLine } from "./codex-toolbox"
import { opencodeDb } from "./opencode-history"
import { OpencodeConfig, opencodeServerOf } from "./opencode-toolbox"
import { emptyKit, kitName, type Kit } from "./toolbox"

// (the agents write ISO timestamps without spaces: the day is its first 10 characters)
const DAY = /"timestamp":"(\d{4}-\d{2}-\d{2})/

/** A line folded with a step 5 line reader: what it adds goes to its day. */
export function dayFold(kitLine: (acc: Kit, line: string) => Kit) {
  return (acc: DayAcc, line: string, fileDay: string): DayAcc => {
    const k = kitLine(emptyKit, line)
    if (k === emptyKit) return acc
    const day = DAY.exec(line)?.[1] ?? fileDay
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
    line: dayFold(addClaudeKitLine),
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
    line: dayFold(addCodexKitLine),
    async loaded() {
      return { mcp: (await config.servers(home())) ?? [], skills: null }
    },
  }
}

/** OpenCode: its tool calls in its database (`part` rows), from `after` (ms) on. MCP tools
 *  are `<server>_<tool>` of a configured server; a skill is the `skill` tool's `name`. */
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
    async store(after: number) {
      const file = db()
      if (!fs.existsSync(file)) return { until: after, days: {} }
      const servers = (await config.servers(undefined)) ?? []
      const d = new DatabaseSync(file, { readOnly: true, timeout: 1000 })
      try {
        const rows = d
          .prepare(
            `select time_created t, json_extract(data, '$.tool') tool,
               json_extract(data, '$.state.input.name') name
             from part where time_created > ? and json_extract(data, '$.type') = 'tool'
             order by time_created limit 200000`,
          )
          .all(after) as { t: number; tool: unknown; name: unknown }[]
        const days: Record<string, Uses> = {}
        let until = after
        for (const r of rows) {
          until = Math.max(until, r.t)
          const tool = kitName(r.tool)
          if (!tool) continue
          const day = new Date(r.t).toISOString().slice(0, 10)
          if (tool === "skill") {
            const n = kitName(r.name)
            if (!n) continue
            const u = (days[day] ??= { mcp: {}, skills: {} })
            u.skills[n] = (u.skills[n] ?? 0) + 1
          } else {
            const s = opencodeServerOf(tool, servers)
            if (!s) continue
            const u = (days[day] ??= { mcp: {}, skills: {} })
            u.mcp[s] = (u.mcp[s] ?? 0) + 1
          }
        }
        return { until, days }
      } finally {
        d.close()
      }
    },
  }
}

/** The sources the sessions worker scans. */
export const inventorySources = (): InventorySource[] => [
  claudeInventory(),
  codexInventory(),
  opencodeInventory(),
]
