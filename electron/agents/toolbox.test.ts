import { describe, it, expect } from "vitest"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { SubUses, Tickets, addUses, bump, emptyKit, toToolbox, withTool } from "./toolbox"
import { ClaudeMcpConfig, addClaudeKitLine, mcpServerOf } from "./claude-toolbox"
import { addCodexKitLine, codexHomeOf, codexServersIn, CodexMcpConfig } from "./codex-toolbox"
import {
  OpencodeToolbox,
  OpencodeConfig,
  mcpLayer,
  opencodeServerOf,
  opencodeServersOf,
  stripJsonc,
} from "./opencode-toolbox"
import { tokenEventsForBatch } from "../agent-tokens"
import { TranscriptFold } from "../transcript-fold"

const j = (o: unknown) => JSON.stringify(o)
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "minmux-toolbox-"))

describe("toolbox", () => {
  it("bump counts, never below zero, and stops adding names when full", () => {
    expect(bump({}, "a")).toEqual({ a: 1 })
    expect(bump({ a: 1 }, "a", -3)).toEqual({ a: 0 })
    const full = Object.fromEntries(Array.from({ length: 256 }, (_, i) => [`k${i}`, 1]))
    expect(bump(full, "new")).toBe(full)
  })

  it("a Toolbox: listed and configured servers together; skills off when not supported", () => {
    const kit = { ...emptyKit, mcp: { a: 2 }, mcpTools: { a: ["x"], gone: [] }, skills: { s: 1 } }
    expect(toToolbox(kit, ["b"])).toEqual({
      mcp: { a: 2 },
      mcpLoaded: ["a", "b"],
      skills: { s: 1 },
    })
    expect(toToolbox(emptyKit)).toEqual({ mcp: {}, skills: {} }) // nothing known
    expect(toToolbox(emptyKit, [])).toEqual({ mcp: {}, mcpLoaded: [], skills: {} }) // known: none
    expect(toToolbox(kit, undefined, false).skills).toBeNull()
  })

  it("a server seen by its wire name is shown by its configured one", () => {
    const kit = { ...emptyKit, mcp: { my_server: 3 }, mcpTools: { my_server: ["q"] } }
    expect(toToolbox(kit, ["my.server"])).toEqual({
      mcp: { "my.server": 3 },
      mcpLoaded: ["my.server"],
      skills: {},
    })
  })

  it("tools by name: one announced twice and removed once is gone", () => {
    let m = withTool({}, "s", "t", true)
    expect(withTool(m, "s", "t", true)).toBe(m)
    m = withTool(m, "s", "t", false)
    expect(m).toEqual({ s: [] })
  })

  it("sub-agents: one entry each, replaced by a fuller read, never added to", () => {
    const subs = new SubUses()
    const k = (gh: number) => ({ ...emptyKit, mcp: { gh } })
    subs.put("s", "x", k(3))
    subs.put("s", "x", k(4)) // continued: its whole transcript again
    expect(subs.of("s")!.mcp).toEqual({ gh: 4 })
    subs.put("s", "x", k(2)) // an older read finishing last
    expect(subs.of("s")!.mcp).toEqual({ gh: 4 })
    subs.put("s", "y", { ...emptyKit, skills: { r: 1 } })
    const all = addUses({ ...emptyKit, mcp: { gh: 1 } }, subs.of("s"))
    expect([all.mcp, all.skills]).toEqual([{ gh: 5 }, { r: 1 }])
    expect(subs.of("none")).toBeUndefined()
  })

  it("tickets: an older snapshot doesn't go out after a newer one", () => {
    const t = new Tickets()
    const a = t.take("s")
    const b = t.take("s")
    expect(t.send("s", b)).toBe(true)
    expect(t.send("s", a)).toBe(false)
    // A session that ended and resumed keeps counting: an old read can't land last.
    const c = t.take("s")
    expect(t.send("s", t.take("s"))).toBe(true)
    expect(t.send("s", c)).toBe(false)
  })

  it("a session's root is its first folder", () => {
    const subs = new SubUses()
    expect(subs.root("s", "/a")).toBe("/a")
    expect(subs.root("s", "/b")).toBe("/a")
    expect(subs.root("t", undefined)).toBeUndefined()
  })
})

describe("Claude's transcript", () => {
  it("names servers the way the user knows them", () => {
    expect(mcpServerOf("mcp__github__create_issue")).toBe("github")
    expect(mcpServerOf("mcp__claude_ai_Google_Drive__search")).toBe("claude.ai Google Drive")
    expect(mcpServerOf("Bash")).toBeUndefined()
  })

  it("folds the skills it has, the MCP tools it lists, failed servers and the uses", () => {
    const lines = [
      j({
        type: "attachment",
        attachment: { type: "skill_listing", isInitial: true, names: ["review", "run"] },
      }),
      j({ type: "attachment", attachment: { type: "skill_listing", names: ["deploy"] } }),
      j({
        type: "attachment",
        attachment: {
          type: "deferred_tools_delta",
          addedNames: [
            "mcp__github__a",
            "mcp__github__b",
            "mcp__claude_ai_Box__authenticate",
            "WebSearch",
          ],
          failedMcpServers: [{ name: "hexgate", errorCode: "ECONNREFUSED" }],
        },
      }),
      j({
        type: "attachment",
        attachment: { type: "deferred_tools_delta", removedNames: ["mcp__github__a"] },
      }),
      j({
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", name: "mcp__github__b", input: {} },
            { type: "tool_use", name: "Skill", input: { skill: "review" } },
            { type: "tool_use", name: "Bash", input: { command: "ls" } },
          ],
        },
      }),
      "not json {",
      j({ type: "user", message: { content: "a mcp__ mention in text" } }),
    ]
    const kit = lines.reduce(addClaudeKitLine, emptyKit)
    expect(kit.skillsLoaded).toEqual(["review", "run", "deploy"])
    expect(kit.mcpTools).toEqual({ github: ["mcp__github__b"] }) // (a sign-in tool isn't a server's)
    expect(kit.mcpDown).toEqual(["hexgate"])
    expect(kit.mcp).toEqual({ github: 1 })
    expect(kit.skills).toEqual({ review: 1 })
    expect(addClaudeKitLine(kit, j({ type: "assistant", message: { usage: {} } }))).toBe(kit)
  })

  it("its config: user-wide, per project and the folder's .mcp.json", async () => {
    const home = tmp()
    const cwd = path.join(home, "proj")
    fs.mkdirSync(cwd)
    expect(await new ClaudeMcpConfig(home).servers(cwd)).toBeUndefined()
    fs.writeFileSync(
      path.join(home, ".claude.json"),
      j({
        mcpServers: { a: {} },
        projects: {
          [cwd]: {
            mcpServers: { b: {}, off: {} },
            disabledMcpServers: ["off"],
            enabledMcpjsonServers: ["c"],
          },
          other: { mcpServers: { x: {} } },
        },
      }),
    )
    fs.writeFileSync(path.join(cwd, ".mcp.json"), j({ mcpServers: { c: {}, unapproved: {} } }))
    expect(await new ClaudeMcpConfig(home).servers(cwd)).toEqual(["a", "b", "c"])
  })

  it("its config for a session started in a sub-folder, approved in settings, CLAUDE_CONFIG_DIR", async () => {
    const home = tmp()
    const repo = path.join(home, "repo")
    const sub = path.join(repo, "pkg")
    fs.mkdirSync(path.join(repo, ".git"), { recursive: true })
    fs.mkdirSync(path.join(repo, ".claude"))
    fs.mkdirSync(sub)
    const cfg = path.join(home, "work")
    fs.mkdirSync(cfg)
    fs.writeFileSync(
      path.join(cfg, ".claude.json"),
      j({ mcpServers: { u: {} }, projects: { [repo]: { mcpServers: { p: {} } } } }),
    )
    fs.writeFileSync(path.join(repo, ".mcp.json"), j({ mcpServers: { m: {} } }))
    fs.writeFileSync(
      path.join(repo, ".claude", "settings.local.json"),
      j({ enableAllProjectMcpServers: true }),
    )
    const c = new ClaudeMcpConfig(home, { CLAUDE_CONFIG_DIR: cfg })
    expect(await c.servers(sub)).toEqual(["u", "p", "m"])
  })

  it("one read gives the tokens and the toolbox (on Stop; a sub-agent's gives tokens only)", async () => {
    const dir = tmp()
    const tx = path.join(dir, "s.jsonl")
    fs.writeFileSync(
      tx,
      `${j({ type: "assistant", message: { usage: { input_tokens: 5, output_tokens: 2 }, content: [{ type: "tool_use", name: "mcp__gh__x", input: {} }] } })}\n`,
    )
    const reads = new TranscriptFold(
      (a: { n: number; kit: typeof emptyKit }, l: string) => ({
        n: a.n + 1,
        kit: addClaudeKitLine(a.kit, l),
      }),
      { n: 0, kit: emptyKit },
    )
    const out = await tokenEventsForBatch(
      reads,
      [{ event: "Stop", sessionId: "s", transcriptPath: tx }],
      undefined,
      { tokens: (r) => ({ context: r.n, output: 0 }), toolbox: async (r) => toToolbox(r.kit) },
    )
    expect(out).toEqual([
      { event: "TokenUsage", sessionId: "s", tokens: { context: 1, output: 0 } },
      { event: "Toolbox", sessionId: "s", toolbox: { mcp: { gh: 1 }, skills: {} } },
    ])
  })
})

describe("snapshots in order", () => {
  it("two Stops of one session: the slower first read's snapshot is dropped", async () => {
    const dir = tmp()
    const tx = path.join(dir, "s.jsonl")
    fs.writeFileSync(tx, "{}\n")
    const reads = new TranscriptFold((n: number) => n + 1, 0)
    const tickets = new Tickets()
    let first = true
    const view = {
      tokens: (n: number) => ({ context: n, output: 0 }),
      // the first read's config read is slow
      toolbox: async () => {
        const slow = first
        first = false
        await new Promise((r) => setTimeout(r, slow ? 40 : 0))
        return { mcp: {}, skills: {} }
      },
      tickets,
    }
    const stop = [{ event: "Stop", sessionId: "s", transcriptPath: tx }]
    const [a, b] = await Promise.all([
      tokenEventsForBatch(reads, stop, undefined, view),
      tokenEventsForBatch(reads, stop, undefined, view),
    ])
    expect(a).toEqual([]) // (b's went first)
    expect(b.length).toBe(2)
  })
})

describe("Codex's rollout", () => {
  const call = (server: string, status: string) =>
    j({
      type: "event_msg",
      payload: {
        type: "item_completed",
        item: { type: "McpToolCall", server, tool: "ping", status },
      },
    })

  it("counts MCP calls by server, failed ones apart", () => {
    const kit = [
      call("echo", "completed"),
      call("echo", "failed"),
      call("echo", "completed"),
      j({ type: "event_msg", payload: { type: "token_count" } }),
    ].reduce(addCodexKitLine, emptyKit)
    expect(kit.mcp).toEqual({ echo: 2 })
    expect(kit.mcpFailed).toEqual({ echo: 1 })
  })

  it("its config.toml's servers; its home from a rollout path", async () => {
    expect(
      codexServersIn(
        'model = "x"\n[mcp_servers.echo]\ncommand = "node"\n[mcp_servers.echo.env]\nA = "1"\n[mcp_servers."my server"]\n[profiles.x]\n',
      ),
    ).toEqual(["echo", "my server"])
    expect(
      codexServersIn(
        'mcp_servers.root.command = "x"\nmcp_servers.gone.enabled = false\n[mcp_servers]\nin = { command = "node" }\noff = { command = "n", enabled = false }\n[mcp_servers.t]\nenabled = false\n',
      ),
    ).toEqual(["root", "in"])
    expect(codexServersIn('[mcp_servers]\nfoo.command = "npx"\nbar.enabled = false\n')).toEqual([
      "foo",
    ])
    // (a tool's `enabled` under a sub-table isn't the server's)
    expect(
      codexServersIn("[mcp_servers.docs]\n[mcp_servers.docs.tools.search]\nenabled = false\n"),
    ).toEqual(["docs"])
    expect(codexHomeOf("/h/.codex/sessions/2026/11/25/rollout-x.jsonl")).toBe("/h/.codex")
    expect(codexHomeOf("/elsewhere/x.jsonl")).toBeNull()
    const home = tmp()
    expect(await new CodexMcpConfig().servers(home)).toEqual([]) // no config: none
    fs.writeFileSync(path.join(home, "config.toml"), "[mcp_servers.a]\n")
    expect(await new CodexMcpConfig().servers(home)).toEqual(["a"])
  })
})

describe("OpenCode", () => {
  it("reads JSONC (a comma inside a string stays)", () => {
    expect(JSON.parse(stripJsonc('{ "a": "x,]", "b": [1, ], }'))).toEqual({ a: "x,]", b: [1] })
    expect(JSON.parse(stripJsonc('{ // a\n "a": "x//y", /* b */ "c": [1,],\n}'))).toEqual({
      a: "x//y",
      c: [1],
    })
  })

  it("config layers merge: a later one turns a server off, or back on", () => {
    const global = mcpLayer({ mcp: { github: {}, db: { enabled: false } } })
    const project = mcpLayer({ mcp: { github: { enabled: false }, db: { enabled: true } } })
    expect(opencodeServersOf([global, project])).toEqual(["db"])
    expect(mcpLayer({ mcp: [] })).toEqual({})
  })

  it("an MCP tool is its longest configured server's", () => {
    expect(opencodeServerOf("my_db_query", ["my", "my_db"])).toBe("my_db")
    expect(opencodeServerOf("bash", ["my"])).toBeUndefined()
  })

  it("counts a session's MCP calls and skills; config up to the repo root says what it has", async () => {
    const home = tmp()
    const repo = path.join(home, "repo")
    const cwd = path.join(repo, "packages", "app")
    fs.mkdirSync(cwd, { recursive: true })
    fs.mkdirSync(path.join(repo, ".git"))
    fs.mkdirSync(path.join(repo, ".opencode/skill/fleet"), { recursive: true })
    fs.writeFileSync(path.join(repo, ".opencode/skill/fleet/SKILL.md"), "---\nname: fleet\n---\n")
    fs.mkdirSync(path.join(cwd, "skills/not-a-skill-dir"), { recursive: true }) // (not OpenCode's)
    fs.mkdirSync(path.join(home, "dotfiles/linked"), { recursive: true })
    fs.writeFileSync(path.join(home, "dotfiles/linked/SKILL.md"), "x")
    fs.mkdirSync(path.join(home, ".claude/skills"), { recursive: true })
    fs.symlinkSync(path.join(home, "dotfiles/linked"), path.join(home, ".claude/skills/linked"))
    fs.writeFileSync(
      path.join(repo, "opencode.jsonc"),
      '{ "mcp": { "echo": {}, "my.db": {}, "off": { "enabled": false }, }, // x\n }',
    )
    const env = {
      XDG_CONFIG_HOME: path.join(home, "nothing"),
      OPENCODE_CONFIG_CONTENT: '{"mcp":{"inline":{}}}',
    }
    const tb = new OpencodeToolbox(new OpencodeConfig(home, env))
    const start = await tb.events([{ event: "SessionStart", sessionId: "s", cwd }])
    expect(start[0]!.toolbox).toEqual({
      mcp: {},
      mcpLoaded: ["echo", "my.db", "inline"],
      skills: {},
      skillsLoaded: ["linked", "fleet"],
    })
    await tb.events([
      { event: "PreToolUse", sessionId: "s", toolName: "echo_ping" },
      { event: "PreToolUse", sessionId: "s", toolName: "my_db_query" },
      { event: "PreToolUse", sessionId: "s", toolName: "skill", skill: "fleet" },
      { event: "PreToolUse", sessionId: "s", toolName: "bash" },
    ])
    // A switch away and back keeps its counts.
    await tb.events([{ event: "SessionEnd", sessionId: "s", reason: "switch" }])
    const back = await tb.events([{ event: "Stop", sessionId: "s" }])
    expect(back[0]!.toolbox).toEqual({
      mcp: { echo: 1, "my.db": 1 },
      mcpLoaded: ["echo", "my.db", "inline"],
      skills: { fleet: 1 },
      skillsLoaded: ["linked", "fleet"],
    })
    expect(await tb.events([{ event: "UserPromptSubmit", sessionId: "t" }])).toEqual([])
  })
})
