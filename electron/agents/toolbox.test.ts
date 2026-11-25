import { describe, it, expect } from "vitest"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { bump, emptyKit, toToolbox } from "./toolbox"
import { ClaudeMcpConfig, addClaudeKitLine, mcpServerOf } from "./claude-toolbox"
import { addCodexKitLine, codexHomeOf, codexServersIn, CodexMcpConfig } from "./codex-toolbox"
import { OpencodeToolbox, OpencodeConfig, opencodeServerOf, stripJsonc } from "./opencode-toolbox"
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
    const kit = { ...emptyKit, mcp: { a: 2 }, mcpTools: { a: 3, gone: 0 }, skills: { s: 1 } }
    expect(toToolbox(kit, ["b"])).toEqual({
      mcp: { a: 2 },
      mcpLoaded: ["a", "b"],
      skills: { s: 1 },
    })
    expect(toToolbox(emptyKit)).toEqual({ mcp: {}, skills: {} }) // nothing known
    expect(toToolbox(emptyKit, [])).toEqual({ mcp: {}, mcpLoaded: [], skills: {} }) // known: none
    expect(toToolbox(kit, undefined, false).skills).toBeNull()
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
    expect(kit.mcpTools).toEqual({ github: 1 }) // (a sign-in tool isn't a server's)
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
        projects: { [cwd]: { mcpServers: { b: {} } }, other: { mcpServers: { x: {} } } },
      }),
    )
    fs.writeFileSync(path.join(cwd, ".mcp.json"), j({ mcpServers: { c: {} } }))
    expect(await new ClaudeMcpConfig(home).servers(cwd)).toEqual(["a", "b", "c"])
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
      (r) => ({ tokens: { context: r.n, output: 0 }, toolbox: toToolbox(r.kit) }),
    )
    expect(out).toEqual([
      { event: "TokenUsage", sessionId: "s", tokens: { context: 1, output: 0 } },
      { event: "Toolbox", sessionId: "s", toolbox: { mcp: { gh: 1 }, skills: {} } },
    ])
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
    expect(codexHomeOf("/h/.codex/sessions/2026/11/25/rollout-x.jsonl")).toBe("/h/.codex")
    expect(codexHomeOf("/elsewhere/x.jsonl")).toBeNull()
    const home = tmp()
    expect(await new CodexMcpConfig().servers(home)).toEqual([]) // no config: none
    fs.writeFileSync(path.join(home, "config.toml"), "[mcp_servers.a]\n")
    expect(await new CodexMcpConfig().servers(home)).toEqual(["a"])
  })
})

describe("OpenCode", () => {
  it("reads JSONC", () => {
    expect(JSON.parse(stripJsonc('{ // a\n "a": "x//y", /* b */ "c": [1,],\n}'))).toEqual({
      a: "x//y",
      c: [1],
    })
  })

  it("an MCP tool is its longest configured server's", () => {
    expect(opencodeServerOf("my_db_query", ["my", "my_db"])).toBe("my_db")
    expect(opencodeServerOf("bash", ["my"])).toBeUndefined()
  })

  it("counts a session's MCP calls and skills; its config and skill folders give what it has", async () => {
    const home = tmp()
    const cwd = path.join(home, "proj")
    fs.mkdirSync(path.join(cwd, ".opencode/skill/fleet"), { recursive: true })
    fs.writeFileSync(path.join(cwd, ".opencode/skill/fleet/SKILL.md"), "---\nname: fleet\n---\n")
    fs.writeFileSync(path.join(cwd, "opencode.jsonc"), '{ "mcp": { "echo": {}, }, // x\n }')
    const prev = process.env.XDG_CONFIG_HOME
    process.env.XDG_CONFIG_HOME = path.join(home, "nothing")
    try {
      const tb = new OpencodeToolbox(new OpencodeConfig(home))
      const start = await tb.events([{ event: "SessionStart", sessionId: "s", cwd }])
      expect(start[0]!.toolbox).toEqual({
        mcp: {},
        mcpLoaded: ["echo"],
        skills: {},
        skillsLoaded: ["fleet"],
      })
      const stop = await tb.events([
        { event: "PreToolUse", sessionId: "s", toolName: "echo_ping" },
        { event: "PreToolUse", sessionId: "s", toolName: "skill", skill: "fleet" },
        { event: "PreToolUse", sessionId: "s", toolName: "bash" },
        { event: "Stop", sessionId: "s" },
      ])
      expect(stop).toEqual([
        {
          event: "Toolbox",
          sessionId: "s",
          toolbox: {
            mcp: { echo: 1 },
            mcpLoaded: ["echo"],
            skills: { fleet: 1 },
            skillsLoaded: ["fleet"],
          },
        },
      ])
      await tb.events([{ event: "SessionEnd", sessionId: "s" }])
      expect(await tb.events([{ event: "UserPromptSubmit", sessionId: "s" }])).toEqual([])
    } finally {
      if (prev === undefined) delete process.env.XDG_CONFIG_HOME
      else process.env.XDG_CONFIG_HOME = prev
    }
  })
})
