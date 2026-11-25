// The Claude and Codex adapters' toolbox (step 5): one transcript read gives the token totals
// and the session's MCP servers and skills, its sub-agents' uses included; plus the line
// readers' edge cases.
import { describe, it, expect, beforeEach, afterEach } from "vitest"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { createClaudeAdapter } from "./claude"
import { createCodexAdapter } from "./codex"
import { addClaudeKitLine } from "./claude-toolbox"
import { addCodexKitLine } from "./codex-toolbox"
import { emptyKit, toToolbox } from "./toolbox"
import type { AgentEvent } from "../../src/lib/agent-graph"

const j = (o: unknown) => JSON.stringify(o)
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "minmux-tb-"))
const use = (name: string, input: unknown = {}) =>
  `${j({ type: "assistant", message: { usage: { input_tokens: 10, output_tokens: 1 }, content: [{ type: "tool_use", name, input }] } })}\n`
const toolboxOf = (out: AgentEvent[]) => out.find((e) => e.event === "Toolbox")?.toolbox

describe("the Claude adapter's toolbox", () => {
  let prev: string | undefined
  let cfg: string
  beforeEach(() => {
    prev = process.env.CLAUDE_CONFIG_DIR
    cfg = tmp() // (never the real ~/.claude.json)
    process.env.CLAUDE_CONFIG_DIR = cfg
  })
  afterEach(() => {
    if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = prev
  })

  it("a Stop sends tokens and the toolbox; a sub-agent's uses join the next one, once", async () => {
    fs.writeFileSync(path.join(cfg, ".claude.json"), j({ mcpServers: { linear: {} } }))
    const dir = tmp()
    const tx = path.join(dir, "s.jsonl")
    fs.writeFileSync(tx, use("mcp__gh__x") + use("Skill", { skill: "review" }))
    fs.mkdirSync(path.join(dir, "s", "subagents"), { recursive: true })
    const sub = path.join(dir, "s", "subagents", "agent-a1.jsonl")
    fs.writeFileSync(sub, use("mcp__gh__y"))
    const a = createClaudeAdapter()
    const stop = { event: "Stop", sessionId: "s", cwd: dir, transcriptPath: tx }
    const first = await a.usage!([stop], (p) => [p])
    expect(first.map((e) => e.event)).toEqual(["TokenUsage", "Toolbox"])
    expect(toolboxOf(first)).toMatchObject({
      mcp: { gh: 1 },
      mcpLoaded: ["linear"],
      skills: { review: 1 },
    })
    const subStop = { event: "SubagentStop", sessionId: "s", agentId: "a1", transcriptPath: tx }
    await a.usage!([subStop], (p) => [p])
    fs.appendFileSync(sub, use("mcp__gh__z")) // continued: read whole again, counted once
    await a.usage!([subStop], (p) => [p])
    const next = await a.usage!([stop], (p) => [p])
    expect(toolboxOf(next)!.mcp).toEqual({ gh: 3 })
    await a.usage!([{ event: "SessionEnd", sessionId: "s", transcriptPath: tx }], (p) => [p])
  })
})

describe("the Codex adapter's toolbox", () => {
  it("MCP calls from the rollout, servers from its home's config.toml, skills not supported", async () => {
    const home = tmp()
    const day = path.join(home, "sessions", "2026", "11", "25")
    fs.mkdirSync(day, { recursive: true })
    fs.writeFileSync(path.join(home, "config.toml"), "[mcp_servers.echo]\ncommand = 'node'\n")
    const rollout = path.join(day, "rollout-x.jsonl")
    fs.writeFileSync(
      rollout,
      `${j({ type: "event_msg", payload: { type: "item_completed", item: { type: "McpToolCall", server: "echo", tool: "ping", status: "completed" } } })}\n`,
    )
    const a = createCodexAdapter()
    const out = await a.usage!(
      [{ event: "Stop", sessionId: "c", transcriptPath: rollout }],
      (p) => [p],
    )
    expect(toolboxOf(out)).toEqual({ mcp: { echo: 1 }, mcpLoaded: ["echo"], skills: null })
  })
})

describe("the line readers' edges", () => {
  it("Claude: a later listing adds; odd shapes say nothing", () => {
    const listed = [
      j({
        type: "attachment",
        attachment: { type: "skill_listing", isInitial: true, names: ["a"] },
      }),
      j({ type: "attachment", attachment: { type: "skill_listing", names: ["b", 3, ""] } }),
      j({
        type: "attachment",
        attachment: { type: "deferred_tools_delta", failedMcpServers: ["down"] },
      }),
      j({ type: "attachment", attachment: { type: "deferred_tools_delta", addedNames: "no" } }),
      j({ type: "attachment", attachment: { type: "other", x: "mcp__a__b" } }),
      j({ type: "assistant", message: { content: "mcp__ in text" } }),
      j({ type: "assistant", message: null, x: "mcp__a__b" }),
      j({
        type: "assistant",
        message: { content: [null, { type: "tool_use" }, { type: "tool_use", name: "Skill" }] },
      }),
      '"just a string with mcp__"',
    ].reduce(addClaudeKitLine, emptyKit)
    expect(listed.skillsLoaded).toEqual(["a", "b"])
    expect(listed.mcpDown).toEqual(["down"])
    expect(listed.mcp).toEqual({})
    expect(listed.skills).toEqual({})
  })

  it("Codex: other records, no server, bad JSON say nothing", () => {
    const kit = [
      '{"McpToolCall" broken',
      j({
        type: "response_item",
        payload: { type: "item_completed", item: { type: "McpToolCall", server: "x" } },
      }),
      j({ type: "event_msg", payload: { type: "item_completed", item: { type: "McpToolCall" } } }),
      j({
        type: "event_msg",
        payload: { type: "item_completed", item: { type: "Other", x: "McpToolCall" } },
      }),
    ].reduce(addCodexKitLine, emptyKit)
    expect(kit).toBe(emptyKit)
  })

  it("a toolbox keeps failed calls and down servers", () => {
    const tb = toToolbox({ ...emptyKit, mcpFailed: { x: 2 }, mcpDown: ["y"] })
    expect(tb).toEqual({ mcp: {}, mcpFailed: { x: 2 }, mcpDown: ["y"], skills: {} })
  })
})
