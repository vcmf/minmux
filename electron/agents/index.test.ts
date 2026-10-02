import { describe, it, expect } from "vitest"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { AGENTS, AGENT_ENV_VARS, AGENT_RULES, AGENT_SHELL, createAdapters } from "."
import { AVAILABLE_AGENTS } from "../../src/lib/agent-kinds"

describe("agent registry", () => {
  it("derives every list from one spec per agent", () => {
    const kinds = AGENTS.map((a) => a.kind)
    expect(new Set(kinds).size).toBe(kinds.length)
    expect(Object.keys(AGENT_RULES)).toEqual(kinds)
    expect(AGENT_SHELL).toEqual(AGENTS.map((a) => a.shell))
    expect(createAdapters().map((a) => a.kind)).toEqual(kinds)
  })

  it("registers the same agents the renderer offers (Settings switches, the board's hint)", () => {
    expect(AGENTS.map((a) => a.kind)).toEqual(AVAILABLE_AGENTS)
  })

  it("declares every per-pane env name an adapter sets or WSL forwards", () => {
    expect(AGENT_ENV_VARS).toContain("MINMUX_CLAUDE_SETTINGS")
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "minmux-reg-"))
    try {
      for (const spec of AGENTS) {
        const a = spec.create()
        a.install(dir)
        for (const k of Object.keys(a.env())) expect(spec.shell.env).toContain(k)
        for (const w of spec.shell.wslenv) expect(spec.shell.env).toContain(w.replace(/\/.*$/, ""))
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
