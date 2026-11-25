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

describe("readLines, a giant line", () => {
  it("is skipped to its end, the lines after it read", async () => {
    const f = path.join(tmp(), "g.jsonl")
    fs.writeFileSync(f, `a\n${"x".repeat(9 * 1024 * 1024)}"mcp__x__y"\nb\n`)
    const got: string[] = []
    await readLines(f, 0, fs.statSync(f).size, (l) => got.push(l))
    expect(got).toEqual(["a", "b"])
  })
})

describe("dayFold", () => {
  it("a line's uses go to its own day; loaded lists gather", () => {
    const fold = dayFold(addClaudeKitLine, "last")
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
    // A tool's input holding a timestamp doesn't move the line's day (Claude's own is last).
    const tricky = j({
      type: "assistant",
      message: {
        content: [
          { type: "tool_use", name: "mcp__s__q", input: { timestamp: "2024-01-01T00:00:00Z" } },
        ],
      },
      timestamp: "2026-11-24T10:00:00Z",
    })
    expect(Object.keys(fold(emptyAcc(), tricky, "2026-11-25").days)).toEqual(["2026-11-24"])
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
        return dayFold(addClaudeKitLine, "last")(acc, l, day)
      },
      loaded: async () => ({ mcp: ["cfg"], skills: [] }),
    }
    const a = await scanInventory([src], cache)
    expect(a.claude!.days["2026-11-20"]!.mcp).toEqual({ gh: 1 })
    expect(a.claude!.mcpNow).toEqual(["cfg"])
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
        calls.push(after.t)
        if (fail) throw new Error("locked")
        return {
          until: { t: after.t + 10, id: "x" },
          days: { "2026-11-25": { mcp: { e: 1 }, skills: {} } },
        }
      },
    }
    await scanInventory([src], cache)
    const two = await scanInventory([src], cache)
    expect(calls).toEqual([0, 10])
    expect(two.opencode!.days["2026-11-25"]!.mcp).toEqual({ e: 2 })
    expect(two.opencode!.skillsNow).toBeNull()
    fail = true
    calls = []
    expect((await scanInventory([src], cache)).opencode!.days["2026-11-25"]!.mcp).toEqual({ e: 2 })
  })

  it("keeps what it had: a failed read, a file not listed this time, a newer build's cache", async () => {
    const dir = tmp()
    const cache = path.join(dir, "c.json")
    const f = path.join(dir, "s.jsonl")
    fs.writeFileSync(f, use("mcp__gh__x", "2026-11-20"))
    let list = true
    let broken = false
    const src: InventorySource = {
      kind: "claude",
      files: async () =>
        list ? [{ file: f, size: fs.statSync(f).size, mtimeMs: fs.statSync(f).mtimeMs }] : [],
      line: (acc, l, day) => {
        if (broken) throw new Error("EBUSY")
        return dayFold(addClaudeKitLine, "last")(acc, l, day)
      },
      loaded: async () => ({ mcp: [], skills: [] }),
    }
    await scanInventory([src], cache)
    fs.appendFileSync(f, use("mcp__gh__y", "2026-11-21"))
    broken = true // (its new tail can't be read: the cached count still counts)
    expect((await scanInventory([src], cache)).claude!.days["2026-11-20"]!.mcp).toEqual({ gh: 1 })
    broken = false
    list = false // (its folder unreadable for a moment: the file stays in the cache)
    await scanInventory([src], cache)
    expect(Object.keys((await readCache(cache)).files)).toEqual([f])
    fs.writeFileSync(cache, JSON.stringify({ v: 2, files: {}, stores: {} }))
    await scanInventory([src], cache)
    expect(JSON.parse(fs.readFileSync(cache, "utf8")).v).toBe(2) // never written over
  })

  it("a server seen by its wire name is counted under its configured one", async () => {
    const dir = tmp()
    const f = path.join(dir, "s.jsonl")
    fs.writeFileSync(f, use("mcp__my_server__q", "2026-11-20"))
    const src: InventorySource = {
      kind: "claude",
      files: async () => [{ file: f, size: fs.statSync(f).size, mtimeMs: 0 }],
      line: dayFold(addClaudeKitLine, "last"),
      loaded: async () => ({ mcp: ["my.server"], skills: [] }),
    }
    const inv = await scanInventory([src], path.join(dir, "c.json"))
    expect(inv.claude!.days["2026-11-20"]!.mcp).toEqual({ "my.server": 1 })
    expect(inv.claude!.mcpNow).toEqual(["my.server"])
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

  it("OpenCode: finished tool calls from a mark on, servers as configured where each ran", async () => {
    const dir = tmp()
    const file = path.join(dir, "opencode.db")
    const proj = path.join(dir, "proj")
    fs.mkdirSync(proj)
    fs.writeFileSync(path.join(proj, "opencode.json"), j({ mcp: { linear: {} } }))
    const db = new DatabaseSync(file)
    db.exec("create table part (id text, session_id text, time_created integer, data text)")
    db.exec("create table session (id text, directory text)")
    db.prepare("insert into session values (?, ?)").run("s1", proj)
    const ins = db.prepare("insert into part values (?, ?, ?, ?)")
    const t = Date.now() - 10 * 60_000 // (recent: a running call is still running)
    const today = new Date(t).toISOString().slice(0, 10)
    const tool = (tool: string, status: string, input: unknown = {}) =>
      j({ type: "tool", tool, state: { status, input } })
    ins.run("a", "s1", t, tool("echo_ping", "completed"))
    ins.run("b", "s1", t, tool("linear_issue", "completed")) // (same ms: paged by id)
    ins.run("c", "s1", t + 1, tool("echo_ping", "error"))
    ins.run("d", "s1", t + 2, tool("skill", "completed", { name: "fleet" }))
    ins.run("e", "s1", t + 3, tool("skill", "running"))
    ins.run("f", "s1", t + 4, tool("echo_ping", "completed"))
    ins.run("g", "s1", t + 5, j({ type: "text", text: "hi" }))
    db.close()
    const cfg = path.join(dir, "cfg")
    fs.mkdirSync(path.join(cfg, "opencode"), { recursive: true })
    fs.writeFileSync(path.join(cfg, "opencode", "opencode.json"), j({ mcp: { echo: {} } }))
    const src = opencodeInventory(() => file, new OpencodeConfig(dir, { XDG_CONFIG_HOME: cfg }))
    const got = await src.store!({ t: 0, id: "" })
    expect(got.until).toEqual({ t: t + 2, id: "d" }) // (stopped before the running one)
    // Kept raw (folder and tool), made into servers when the result is built.
    expect(got.days[today]!.mcp).toEqual({
      [`${proj}\0echo_ping`]: 1,
      [`${proj}\0linear_issue`]: 1,
    })
    expect(await src.resolve!(got.days)).toEqual({
      [today]: { mcp: { echo: 1, linear: 1 }, mcpFailed: { echo: 1 }, skills: { fleet: 1 } },
    })
    // Once it finishes, the read goes on from the mark.
    const d2 = new DatabaseSync(file)
    d2.prepare("update part set data = ? where id = 'e'").run(
      tool("skill", "completed", { name: "x" }),
    )
    d2.close()
    const more = await src.store!(got.until)
    expect(await src.resolve!(more.days)).toEqual({
      [today]: { mcp: { echo: 1 }, skills: { x: 1 } },
    })
    // One left running over an hour (its agent died) is passed, uncounted.
    const oldFile = path.join(dir, "old.db")
    const d3 = new DatabaseSync(oldFile)
    d3.exec("create table part (id text, session_id text, time_created integer, data text)")
    d3.exec("create table session (id text, directory text)")
    const old = Date.now() - 3 * 60 * 60_000
    const add = d3.prepare("insert into part values (?, ?, ?, ?)")
    add.run("h", "s1", old, tool("echo_ping", "running"))
    add.run("i", "s1", old + 1, tool("echo_ping", "completed"))
    d3.close()
    const stale = opencodeInventory(
      () => oldFile,
      new OpencodeConfig(dir, { XDG_CONFIG_HOME: cfg }),
    )
    expect((await stale.store!({ t: 0, id: "" })).until).toEqual({ t: old + 1, id: "i" })
    expect(
      await opencodeInventory(() => path.join(dir, "none.db")).store!({ t: 5, id: "" }),
    ).toEqual({
      until: { t: 5, id: "" },
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
