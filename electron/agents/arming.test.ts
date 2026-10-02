import { describe, it, expect } from "vitest"
import { agentPaneEnv, resumablePanes } from "./arming"
import type { LedgerEntry } from "../agent-sessions"

const adapter = (kind: "claude" | "codex", env: Record<string, string>) => ({
  kind,
  env: () => env,
})
const claude = adapter("claude", { MINMUX_CLAUDE_SETTINGS: "/cfg/claude-hooks.json" })
const codex = adapter("codex", { MINMUX_CODEX_ARGS: "/cfg/codex-args" })

describe("agentPaneEnv", () => {
  it("arms every switched-on agent and tags the pane", () => {
    expect(agentPaneEnv([claude, codex], new Set(), "/drops", "p1")).toEqual({
      MINMUX_CLAUDE_SETTINGS: "/cfg/claude-hooks.json",
      MINMUX_CODEX_ARGS: "/cfg/codex-args",
      MINMUX_AGENT_EVENTS: "/drops",
      MINMUX_PANE_ID: "p1",
    })
  })
  it("leaves a switched-off agent out", () => {
    const env = agentPaneEnv([claude, codex], new Set(["codex"]), "/drops", "p1")
    expect(env).not.toHaveProperty("MINMUX_CODEX_ARGS")
    expect(env.MINMUX_CLAUDE_SETTINGS).toBeDefined()
  })
  it("sets nothing, not even the drop root or pane tag, when no agent applies", () => {
    expect(agentPaneEnv([claude], new Set(["claude"]), "/drops", "p1")).toEqual({})
    expect(agentPaneEnv([], new Set(), "/drops", "p1")).toEqual({})
    expect(agentPaneEnv([claude], new Set(), null, "p1")).toEqual({})
  })
})

describe("resumablePanes", () => {
  const entry = (agent?: "claude" | "codex"): LedgerEntry => ({
    agent,
    sessionId: "s",
    cwd: "/r",
    updatedAt: 1,
  })
  const ledger: Record<string, LedgerEntry> = { a: entry(), b: entry("codex") }
  it("drops panes whose saved session is a switched-off agent's; the rest may resume", () => {
    expect(resumablePanes(["a", "b", "c"], (id) => ledger[id], new Set(["codex"]))).toEqual({
      resume: ["a", "c"],
      drop: ["b"],
    })
    expect(resumablePanes(["a", "b"], (id) => ledger[id], new Set(["claude"])).drop).toEqual(["a"])
  })
})
