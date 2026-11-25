// @vitest-environment node
import { describe, it, expect } from "vitest"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"
import {
  emptyAcc,
  readCache,
  readLines,
  scanInventory,
  type InventorySource,
} from "./inventory-scan"
import {
  claudeInventory,
  codexInventory,
  dayFold,
  opencodeInventory,
} from "./agents/inventory-sources"
import { addClaudeKitLine } from "./agents/claude-toolbox"
import { OpencodeConfig } from "./agents/opencode-toolbox"
import { CodexMcpConfig } from "./agents/codex-toolbox"
import { ClaudeMcpConfig } from "./agents/claude-toolbox"
import { SessionsOps, type SessionsReply } from "./sessions-ops"

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "minmux-inv-"))
const j = (o: unknown) => JSON.stringify(o)
const use = (name: string, day: string, input: unknown = {}) =>
  `${j({ type: "assistant", timestamp: `${day}T10:00:00Z`, message: { content: [{ type: "tool_use", name, input }] } })}\n`

describe("readLines", () => {
  it("whole lines only; a partial tail is read again next time", async () => {
    const f = path.join(tmp(), "a.jsonl")
    fs.writeFileSync(f, "one\ntwo\nthr")
    const got: string[] = []
    const at = await readLines(f, 0, fs.statSync(f).size, (l) => got.push(l))
    expect([got, at]).toEqual([["one", "two"], 8])
    fs.appendFileSync(f, "ee\n")
    await readLines(f, at, fs.statSync(f).size, (l) => got.push(l))
    expect(got).toEqual(["one", "two", "three"])
  })
})

describe("dayFold", () => {
  it("a line's uses go to its own day; loaded lists gather", () => {
    const fold = dayFold(addClaudeKitLine)
    let acc = emptyAcc()
    acc = fold(acc, use("mcp__gh__x", "2026-11-20").trim(), "2026-11-25")
    acc = fold(
      acc,
      j({
        type: "assistant",
        message: { content: [{ type: "tool_use", name: "Skill", input: { skill: "r" } }] },
      }),
      "2026-11-25",
    )
    acc = fold(
      acc,
      j({ type: "attachment", attachment: { type: "skill_listing", names: ["r", "s"] } }),
      "2026-11-25",
    )
    acc = fold(
      acc,
      j({
        type: "attachment",
        attachment: { type: "deferred_tools_delta", addedNames: ["mcp__db__q"] },
      }),
      "2026-11-25",
    )
    expect(acc.days).toEqual({
      "2026-11-20": { mcp: { gh: 1 }, skills: {} },
      "2026-11-25": { mcp: {}, skills: { r: 1 } }, // (no timestamp: the file's day)
    })
    expect([acc.skillsLoaded, acc.mcpLoaded]).toEqual([["r", "s"], ["db"]])
    expect(fold(acc, '{"type":"user"}', "2026-11-25")).toBe(acc)
  })
})

describe("scanInventory", () => {
  it("reads only what's new, keeps it in the cache file, and forgets files gone", async () => {
    const dir = tmp()
    const cache = path.join(dir, "cfg", "inventory-cache.json")
    const f = path.join(dir, "s.jsonl")
    fs.writeFileSync(f, use("mcp__gh__x", "2026-11-20"))
    let lines = 0
    const src: InventorySource = {
      kind: "claude",
      files: async () =>
        fs.existsSync(f)
          ? [{ file: f, size: fs.statSync(f).size, mtimeMs: fs.statSync(f).mtimeMs }]
          : [],
      line: (acc, l, day) => {
        lines++
        return dayFold(addClaudeKitLine)(acc, l, day)
      },
      loaded: async () => ({ mcp: ["cfg"], skills: [] }),
    }
    const a = await scanInventory([src], cache)
    expect(a.claude!.days["2026-11-20"]!.mcp).toEqual({ gh: 1 })
    expect(a.claude!.mcpLoaded).toEqual(["cfg"])
    fs.appendFileSync(f, use("mcp__gh__y", "2026-11-21"))
    const b = await scanInventory([src], cache)
    expect(lines).toBe(2) // (the first line wasn't read again)
    expect(b.claude!.days["2026-11-21"]!.mcp).toEqual({ gh: 1 })
    expect(Object.keys((await readCache(cache)).files)).toEqual([f])
    // A file that shrank is read again from the start; one gone leaves the cache.
    fs.writeFileSync(f, use("mcp__db__q", "2026-11-22"))
    const c = await scanInventory([src], cache)
    expect(Object.keys(c.claude!.days)).toEqual(["2026-11-22"])
    fs.rmSync(f)
    await scanInventory([src], cache)
    expect((await readCache(cache)).files).toEqual({})
    fs.writeFileSync(cache, "not json")
    expect((await readCache(cache)).files).toEqual({})
  })

  it("a source's store is read on from where it stopped; a failing one keeps what it had", async () => {
    const cache = path.join(tmp(), "c.json")
    let calls: number[] = []
    let fail = false
    const src: InventorySource = {
      kind: "opencode",
      files: async () => [],
      line: (a) => a,
      loaded: async () => ({ mcp: [], skills: null }),
      store: async (after) => {
        calls.push(after)
        if (fail) throw new Error("locked")
        return { until: after + 10, days: { "2026-11-25": { mcp: { e: 1 }, skills: {} } } }
      },
    }
    await scanInventory([src], cache)
    const two = await scanInventory([src], cache)
    expect(calls).toEqual([0, 10])
    expect(two.opencode!.days["2026-11-25"]!.mcp).toEqual({ e: 2 })
    expect(two.opencode!.skillsLoaded).toBeNull()
    fail = true
    calls = []
    expect((await scanInventory([src], cache)).opencode!.days["2026-11-25"]!.mcp).toEqual({ e: 2 })
  })
})

describe("the agents' sources", () => {
  it("Claude: transcripts and their sub-agents'", async () => {
    const root = tmp()
    const proj = path.join(root, "projects", "-w")
    fs.mkdirSync(path.join(proj, "s1", "subagents"), { recursive: true })
    fs.writeFileSync(path.join(proj, "s1.jsonl"), use("mcp__gh__x", "2026-11-20"))
    fs.writeFileSync(
      path.join(proj, "s1", "subagents", "agent-a.jsonl"),
      use("mcp__gh__y", "2026-11-20"),
    )
    const src = claudeInventory(() => root, new ClaudeMcpConfig(root, { CLAUDE_CONFIG_DIR: root }))
    expect((await src.files()).map((f) => path.basename(f.file)).sort()).toEqual([
      "agent-a.jsonl",
      "s1.jsonl",
    ])
    expect(await claudeInventory(() => path.join(root, "none")).files()).toEqual([])
    expect((await src.loaded()).skills).toEqual([])
  })

  it("Codex: rollouts and archived ones; skills not supported", async () => {
    const home = tmp()
    fs.mkdirSync(path.join(home, "sessions", "2026", "11", "25"), { recursive: true })
    fs.mkdirSync(path.join(home, "archived_sessions"))
    fs.writeFileSync(path.join(home, "sessions", "2026", "11", "25", "rollout-a.jsonl"), "{}\n")
    fs.writeFileSync(path.join(home, "archived_sessions", "rollout-b.jsonl"), "{}\n")
    const src = codexInventory(() => home, new CodexMcpConfig())
    expect((await src.files()).length).toBe(2)
    expect(await src.loaded()).toEqual({ mcp: [], skills: null })
  })

  it("OpenCode: its database's tool calls from a time on", async () => {
    const dir = tmp()
    const file = path.join(dir, "opencode.db")
    const db = new DatabaseSync(file)
    db.exec("create table part (id text, time_created integer, data text)")
    const ins = db.prepare("insert into part values (?, ?, ?)")
    const t = Date.parse("2026-11-25T10:00:00Z")
    ins.run("1", t, j({ type: "tool", tool: "echo_ping", state: { input: {} } }))
    ins.run("2", t + 1, j({ type: "tool", tool: "skill", state: { input: { name: "fleet" } } }))
    ins.run("3", t + 2, j({ type: "tool", tool: "bash", state: { input: {} } }))
    ins.run("4", t + 3, j({ type: "text", text: "hi" }))
    db.close()
    const cfg = path.join(dir, "cfg")
    fs.mkdirSync(path.join(cfg, "opencode"), { recursive: true })
    fs.writeFileSync(path.join(cfg, "opencode", "opencode.json"), j({ mcp: { echo: {} } }))
    const src = opencodeInventory(() => file, new OpencodeConfig(dir, { XDG_CONFIG_HOME: cfg }))
    const got = await src.store!(0)
    expect(got.until).toBe(t + 2)
    expect(got.days).toEqual({ "2026-11-25": { mcp: { echo: 1 }, skills: { fleet: 1 } } })
    expect((await src.store!(got.until)).days).toEqual({})
    expect(await opencodeInventory(() => path.join(dir, "none.db")).store!(5)).toEqual({
      until: 5,
      days: {},
    })
  })
})

describe("the worker's inventory request", () => {
  it("one scan at a time, reused while recent", async () => {
    let scans = 0
    const src: InventorySource = {
      kind: "claude",
      files: async () => {
        scans++
        return []
      },
      line: (a) => a,
      loaded: async () => ({ mcp: [], skills: [] }),
    }
    const replies: SessionsReply[] = []
    const ops = new SessionsOps(
      {},
      (r) => replies.push(r),
      undefined,
      undefined,
      () => [src],
    )
    const cacheFile = path.join(tmp(), "c.json")
    ops.handle({ id: 1, op: "inventory", cacheFile })
    ops.handle({ id: 2, op: "inventory", cacheFile })
    await new Promise((r) => setTimeout(r, 50))
    ops.handle({ id: 3, op: "inventory", cacheFile })
    await new Promise((r) => setTimeout(r, 50))
    expect(scans).toBe(1)
    expect(replies.map((r) => r.id).sort()).toEqual([1, 2, 3])
  })
})
