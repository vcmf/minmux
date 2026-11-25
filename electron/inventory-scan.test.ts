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
import type { Uses } from "../src/lib/fleet-inventory"

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
  it("reads only what's new; a ledger: a file moved or deleted keeps its counts", async () => {
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
    expect(Object.keys((await readCache(cache)).files)).toEqual(["claude:s.jsonl"])
    // Moved (archived): the same entry, not read again, counted once.
    const moved = path.join(dir, "archived", "s.jsonl")
    fs.mkdirSync(path.dirname(moved))
    fs.renameSync(f, moved)
    const g = f
    ;(src as { files: InventorySource["files"] }).files = async () =>
      fs.existsSync(moved)
        ? [{ file: moved, size: fs.statSync(moved).size, mtimeMs: fs.statSync(moved).mtimeMs }]
        : []
    const m = await scanInventory([src], cache)
    expect(lines).toBe(2)
    expect(m.claude!.days["2026-11-20"]!.mcp).toEqual({ gh: 1 })
    expect((await readCache(cache)).files["claude:s.jsonl"]!.path).toBe(moved)
    // Deleted (an agent's cleanup): its counts stay.
    fs.rmSync(moved)
    const d = await scanInventory([src], cache)
    expect(d.claude!.days["2026-11-21"]!.mcp).toEqual({ gh: 1 })
    // One that shrank is read again from the start.
    fs.writeFileSync(moved, use("mcp__db__q", "2026-11-22"))
    const c = await scanInventory([src], cache)
    expect(Object.keys(c.claude!.days)).toEqual(["2026-11-22"])
    expect(g).toBe(f)
    fs.writeFileSync(cache, "not json")
    expect((await readCache(cache)).files).toEqual({})
  })

  it("a database's sessions: recounted only when changed, kept when gone or unreadable", async () => {
    const cache = path.join(tmp(), "c.json")
    const asked: Record<string, string>[] = []
    let fail = false
    let db: Record<string, { sig: string; days: Record<string, Uses> }> = {
      s1: { sig: "1:1", days: { "2026-11-25": { mcp: { e: 1 }, skills: {} } } },
      s2: { sig: "1:1", days: { "2026-11-24": { mcp: { e: 2 }, skills: {} } } },
    }
    const src: InventorySource = {
      kind: "opencode",
      files: async () => [],
      line: (a) => a,
      loaded: async () => ({ mcp: [], skills: null }),
      sessions: async (known) => {
        asked.push(Object.fromEntries(Object.entries(known).map(([id, e]) => [id, e.sig])))
        if (fail) throw new Error("locked")
        return Object.fromEntries(Object.entries(db).filter(([id, e]) => known[id]?.sig !== e.sig))
      },
    }
    await scanInventory([src], cache)
    // s1 grew (recounted, replaced); s2 deleted from the database (kept).
    db = { s1: { sig: "2:2", days: { "2026-11-25": { mcp: { e: 3 }, skills: {} } } } }
    const two = await scanInventory([src], cache)
    expect(asked[1]).toEqual({ s1: "1:1", s2: "1:1" })
    expect(two.opencode!.days).toEqual({
      "2026-11-25": { mcp: { e: 3 }, skills: {} },
      "2026-11-24": { mcp: { e: 2 }, skills: {} },
    })
    expect(two.opencode!.skillsNow).toBeNull()
    fail = true
    expect((await scanInventory([src], cache)).opencode!.days["2026-11-25"]!.mcp).toEqual({ e: 3 })
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
    expect(Object.keys((await readCache(cache)).files)).toEqual(["claude:s.jsonl"])
    fs.writeFileSync(cache, JSON.stringify({ v: 3, files: {}, stores: {} }))
    await scanInventory([src], cache)
    expect(JSON.parse(fs.readFileSync(cache, "utf8")).v).toBe(3) // never written over
  })

  it("one file listed twice in a scan (moved while the folders were walked) is read once", async () => {
    const dir = tmp()
    const f = path.join(dir, "rollout-x.jsonl")
    fs.writeFileSync(f, use("mcp__gh__x", "2026-11-20"))
    const g = path.join(dir, "archived", "rollout-x.jsonl")
    fs.mkdirSync(path.dirname(g))
    fs.copyFileSync(f, g)
    const st = fs.statSync(f)
    const src: InventorySource = {
      kind: "codex",
      files: async () => [
        { file: f, size: st.size, mtimeMs: st.mtimeMs },
        { file: g, size: st.size, mtimeMs: st.mtimeMs },
      ],
      line: dayFold(addClaudeKitLine, "last"),
      loaded: async () => ({ mcp: [], skills: null }),
    }
    const cache = path.join(dir, "c.json")
    const a = await scanInventory([src], cache)
    expect(a.codex!.days["2026-11-20"]!.mcp).toEqual({ gh: 1 })
    expect(Object.keys((await readCache(cache)).files)).toEqual(["codex:rollout-x.jsonl"])
  })

  it("a newer build's cache: this build's ledger in memory, never read from nothing again", async () => {
    const dir = tmp()
    const cache = path.join(dir, "c.json")
    fs.writeFileSync(cache, JSON.stringify({ v: 99, files: {}, stores: {} }))
    const f = path.join(dir, "s.jsonl")
    fs.writeFileSync(f, use("mcp__gh__x", "2026-11-20"))
    let lines = 0
    const src: InventorySource = {
      kind: "claude",
      files: async () => [{ file: f, size: fs.statSync(f).size, mtimeMs: 0 }],
      line: (acc, l, d) => {
        lines++
        return dayFold(addClaudeKitLine, "last")(acc, l, d)
      },
      loaded: async () => ({ mcp: [], skills: [] }),
    }
    await scanInventory([src], cache)
    await scanInventory([src], cache)
    expect(lines).toBe(1)
    expect(JSON.parse(fs.readFileSync(cache, "utf8")).v).toBe(99)
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

  it("OpenCode: a session's finished calls, recounted when its parts change", async () => {
    const dir = tmp()
    const file = path.join(dir, "opencode.db")
    const proj = path.join(dir, "proj")
    fs.mkdirSync(proj)
    fs.writeFileSync(path.join(proj, "opencode.json"), j({ mcp: { linear: {} } }))
    const db = new DatabaseSync(file)
    db.exec(
      "create table part (id text, session_id text, time_created integer, time_updated integer, data text)",
    )
    db.exec("create table session (id text, directory text, time_updated integer)")
    db.prepare("insert into session values (?, ?, ?)").run("s1", proj, 1)
    const ins = db.prepare("insert into part values (?, ?, ?, ?, ?)")
    const t = Date.parse("2026-11-25T10:00:00Z")
    const tool = (tool: string, status: string, input: unknown = {}) =>
      j({ type: "tool", tool, state: { status, input } })
    ins.run("a", "s1", t, t, tool("echo_ping", "completed"))
    ins.run("b", "s1", t, t, tool("linear_issue", "completed"))
    ins.run("c", "s1", t + 1, t + 1, tool("echo_ping", "error"))
    ins.run("d", "s1", t + 2, t + 2, tool("skill", "completed", { name: "fleet" }))
    ins.run("e", "s1", t + 3, t + 3, tool("skill", "running"))
    ins.run("f", "s1", t + 4, t + 4, tool("bash", "completed"))
    ins.run("g", "s1", t + 5, t + 5, tool("gone_q", "completed"))
    ins.run("h", "s1", null as never, null as never, tool("echo_ping", "completed"))
    ins.run("i", "s1", t + 6, t + 6, j({ type: "text", text: "hi" }))
    db.close()
    const cfg = path.join(dir, "cfg")
    fs.mkdirSync(path.join(cfg, "opencode"), { recursive: true })
    fs.writeFileSync(path.join(cfg, "opencode", "opencode.json"), j({ mcp: { echo: {} } }))
    const src = opencodeInventory(() => file, new OpencodeConfig(dir, { XDG_CONFIG_HOME: cfg }))
    const got = await src.sessions!({})
    // Named when read, while their servers are configured; the running call not yet counted.
    expect(got.s1!.days["2026-11-25"]).toMatchObject({
      mcp: { "=echo": 1, "=linear": 1 },
      mcpFailed: { "=echo": 1 },
      skills: { fleet: 1 },
    })
    expect(await src.resolve!(got.s1!.days)).toEqual({
      "2026-11-25": {
        mcp: { echo: 1, linear: 1 },
        mcpFailed: { echo: 1 },
        skills: { fleet: 1 },
      },
    })
    // A call still running: read again each time (same counts) until it's done.
    expect(got.s1!.open).toBe(true)
    expect((await src.sessions!({ s1: got.s1! })).s1!.days).toEqual(got.s1!.days)
    const d2 = new DatabaseSync(file)
    d2.prepare("update part set data = ?, time_updated = ? where id = 'e'").run(
      tool("skill", "completed", { name: "x" }),
      t + 9,
    )
    // (no new part, no session update: it was running at the last count, so it's read again)
    d2.close()
    // A server removed from the config: a recount still names its calls as before.
    fs.rmSync(path.join(proj, "opencode.json"))
    const again = await src.sessions!({ s1: got.s1! })
    expect(again.s1!.days["2026-11-25"]!.skills).toEqual({ fleet: 1, x: 1 })
    expect((await src.resolve!(again.s1!.days))["2026-11-25"]!.mcp).toEqual({ echo: 1, linear: 1 })
    // (a schema whose sessions have no time: the part count alone)
    const d4 = new DatabaseSync(file)
    d4.exec("alter table session drop column time_updated")
    d4.close()
    expect(Object.keys(await src.sessions!({}))).toEqual(["s1"])
    expect(await opencodeInventory(() => path.join(dir, "none.db")).sessions!({})).toEqual({})
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
