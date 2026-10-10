import { describe, it, expect } from "vitest"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { notADrop, startHookWatcher } from "./agent-hooks"
import { normalizeHookEvent } from "./agents/claude"
import type { AgentEvent } from "../src/lib/agent-graph"

const waitUntil = async (cond: () => boolean, ms = 4000) => {
  const start = Date.now()
  while (!cond() && Date.now() - start < ms) await new Promise((r) => setTimeout(r, 15))
  if (!cond()) throw new Error("condition not met within timeout")
}

describe("normalizeHookEvent", () => {
  it("normalises a sub-agent tool event", () => {
    const ev = normalizeHookEvent(
      {
        hook_event_name: "PreToolUse",
        session_id: "s1",
        agent_id: "a1",
        agent_type: "Explore",
        cwd: "/repo",
        tool_name: "Read",
        tool_input: { file_path: "/repo/x.ts" },
      },
      "pane-7",
    )
    expect(ev).toEqual({
      agent: "claude",
      event: "PreToolUse",
      sessionId: "s1",
      paneId: "pane-7",
      agentId: "a1",
      agentType: "Explore",
      cwd: "/repo",
      toolName: "Read",
      toolKey: expect.stringMatching(/^Read:[0-9a-f]{16}$/), // the call's identity, no content
      filePath: "/repo/x.ts",
      message: undefined,
    })
  })

  it("falls back to last_assistant_message; drops payloads missing the essentials", () => {
    expect(
      normalizeHookEvent({
        hook_event_name: "SubagentStop",
        session_id: "s1",
        last_assistant_message: "hi",
      })?.message,
    ).toBe("hi")
    expect(normalizeHookEvent({ session_id: "s1" })).toBeNull() // no event name
    expect(normalizeHookEvent({ hook_event_name: "Stop" })).toBeNull() // no session id
    expect(normalizeHookEvent(null)).toBeNull()
  })
})

describe("notADrop (what the watcher doesn't even poll)", () => {
  const file = { isFile: () => true }
  const folder = { isFile: () => false }
  it("any file but a .json drop: a writer's temp file, our claim files, anything else", () => {
    expect(notADrop("/r/opencode/.pane.1.2.a.tmp", file)).toBe(true)
    expect(notADrop("/r/claude/pane.1.2.a.json.rd", file)).toBe(true)
    expect(notADrop("/r/claude/.DS_Store", file)).toBe(true)
    expect(notADrop("/r/claude/pane.1.2.a.json", file)).toBe(false)
    expect(notADrop("/r/claude", folder)).toBe(false) // its folders are watched
    expect(notADrop("/r/claude/x.tmp")).toBe(false) // no stats yet: asked again with them
  })
})

describe("startHookWatcher", () => {
  // A drop root with one folder per agent, as main lays it out.
  const makeRoot = (...agents: string[]) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "minmux-watch-"))
    for (const a of agents) fs.mkdirSync(path.join(dir, a))
    return dir
  }
  const claude = { claude: normalizeHookEvent }

  it("parses a dropped event file, tags the pane from its name, deletes it, and batches", async () => {
    const dir = makeRoot("claude")
    const batches: AgentEvent[][] = []
    const w = await startHookWatcher({
      dir,
      agents: claude,
      onBatch: (b) => batches.push(b),
      coalesceMs: 10,
    })
    try {
      const file = path.join(dir, "claude", "pane-9.111.222.abc.json")
      fs.writeFileSync(
        file,
        JSON.stringify({ hook_event_name: "SessionStart", session_id: "s1", cwd: "/repo" }),
      )
      await waitUntil(() => batches.length > 0)
      expect(batches.flat()).toHaveLength(1)
      expect(batches.flat()[0]).toMatchObject({
        agent: "claude",
        event: "SessionStart",
        sessionId: "s1",
        paneId: "pane-9", // parsed from the filename prefix
        cwd: "/repo",
      })
      // the drop file is consumed (read + deleted)
      await waitUntil(() => fs.readdirSync(path.join(dir, "claude")).length === 0)
    } finally {
      await w.close()
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
    }
  })

  it("normalises each folder with its own agent's normaliser", async () => {
    const dir = makeRoot("claude", "codex")
    const seen: AgentEvent[] = []
    const codex = (raw: unknown, paneId?: string) => {
      const ev = normalizeHookEvent(raw, paneId)
      return ev && { ...ev, agent: "codex" as const }
    }
    const w = await startHookWatcher({
      dir,
      agents: { ...claude, codex },
      coalesceMs: 10,
      onBatch: (b) => seen.push(...b),
    })
    try {
      for (const a of ["claude", "codex"])
        fs.writeFileSync(
          path.join(dir, a, `p.1.0.${a}.json`),
          JSON.stringify({ hook_event_name: "Stop", session_id: a }),
        )
      await waitUntil(() => seen.length === 2)
      expect(Object.fromEntries(seen.map((e) => [e.sessionId, e.agent]))).toEqual({
        claude: "claude",
        codex: "codex",
      })
    } finally {
      await w.close()
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
    }
  })

  it("accepts a root given with a trailing separator", async () => {
    const dir = makeRoot("claude")
    const seen: AgentEvent[] = []
    const w = await startHookWatcher({
      dir: dir + path.sep,
      agents: claude,
      coalesceMs: 10,
      onBatch: (b) => seen.push(...b),
    })
    try {
      fs.writeFileSync(
        path.join(dir, "claude", "p.1.0.x.json"),
        JSON.stringify({ hook_event_name: "Stop", session_id: "t" }),
      )
      await waitUntil(() => seen.length === 1)
    } finally {
      await w.close()
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
    }
  })

  it("leaves files in the root, in unknown folders and deeper alone", async () => {
    const dir = makeRoot("claude", "other")
    fs.mkdirSync(path.join(dir, "claude", "deep"))
    const seen: AgentEvent[] = []
    const w = await startHookWatcher({
      dir,
      agents: claude,
      coalesceMs: 10,
      sweepMs: 20,
      onBatch: (b) => seen.push(...b),
    })
    const stray = [
      path.join(dir, "p.1.0.root.json"),
      path.join(dir, "other", "p.1.0.other.json"),
      path.join(dir, "claude", "deep", "p.1.0.deep.json"),
    ]
    try {
      const body = JSON.stringify({ hook_event_name: "Stop", session_id: "x" })
      for (const f of stray) fs.writeFileSync(f, body)
      fs.writeFileSync(path.join(dir, "claude", "p.1.0.ok.json"), body) // the one that counts
      await waitUntil(() => seen.length === 1)
      await new Promise((r) => setTimeout(r, 120)) // several sweeps: still nothing else
      expect(seen).toHaveLength(1)
      for (const f of stray) expect(fs.existsSync(f)).toBe(true) // not claimed, not deleted
    } finally {
      await w.close()
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
    }
  })

  it("returns at once with nothing to watch (no agent armed) instead of waiting forever", async () => {
    const dir = makeRoot()
    const w = await Promise.race([
      startHookWatcher({ dir, agents: {}, onBatch: () => {} }),
      new Promise<null>((r) => setTimeout(() => r(null), 1000)),
    ])
    expect(w).not.toBeNull()
    await w?.close()
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  })

  it("tags each event with the folder it came from, whatever the normaliser says", async () => {
    const dir = makeRoot("codex")
    const seen: AgentEvent[] = []
    const w = await startHookWatcher({
      dir,
      agents: { codex: normalizeHookEvent }, // Claude's normaliser: it says "claude"
      coalesceMs: 10,
      onBatch: (b) => seen.push(...b),
    })
    try {
      fs.writeFileSync(
        path.join(dir, "codex", "p.4242.0.x.json"),
        JSON.stringify({ hook_event_name: "Stop", session_id: "s" }),
      )
      await waitUntil(() => seen.length === 1)
      expect(seen[0]!.agent).toBe("codex")
      expect(seen[0]!.pid).toBe(4242) // the agent process, from the drop's name
    } finally {
      await w.close()
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
    }
  })

  it("reports every drop's process, even one that is no event (OpenCode's at load)", async () => {
    const dir = makeRoot("opencode")
    const procs: [string, string, number][] = []
    const seen: AgentEvent[] = []
    const w = await startHookWatcher({
      dir,
      agents: { opencode: () => null }, // e.g. its `started`: no session yet
      coalesceMs: 10,
      onBatch: (b) => seen.push(...b),
      onDrop: (agent, paneId, pid) => {
        procs.push([agent, paneId, pid])
        if (pid === 4243) throw new Error("a consumer error") // never takes the watcher down
      },
    })
    try {
      fs.writeFileSync(path.join(dir, "opencode", "pane-3.4243.1.a.json"), "{}")
      fs.writeFileSync(path.join(dir, "opencode", "pane-3.4242.2.b.json"), "{}")
      fs.writeFileSync(path.join(dir, "opencode", "pane-3.1.3.c.json"), "{}") // orphaned: unknown
      await waitUntil(() => fs.readdirSync(path.join(dir, "opencode")).length === 0)
      await waitUntil(() => procs.length === 2)
      expect(procs.sort()).toEqual([
        ["opencode", "pane-3", 4242],
        ["opencode", "pane-3", 4243],
      ])
      expect(seen).toEqual([])
    } finally {
      await w.close()
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
    }
  })

  it("survives a normaliser that throws", async () => {
    const dir = makeRoot("claude")
    const seen: AgentEvent[] = []
    let calls = 0
    const flaky = (raw: unknown, paneId?: string) => {
      if (calls++ === 0) throw new Error("boom")
      return normalizeHookEvent(raw, paneId)
    }
    const w = await startHookWatcher({
      dir,
      agents: { claude: flaky },
      coalesceMs: 10,
      onBatch: (b) => seen.push(...b),
    })
    try {
      const body = (id: string) => JSON.stringify({ hook_event_name: "Stop", session_id: id })
      fs.writeFileSync(path.join(dir, "claude", "p.1.0.a.json"), body("a"))
      await waitUntil(() => calls === 1)
      fs.writeFileSync(path.join(dir, "claude", "p.1.1.b.json"), body("b"))
      await waitUntil(() => seen.length === 1)
      expect(seen[0]!.sessionId).toBe("b")
    } finally {
      await w.close()
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
    }
  })

  it("delivers every event under a burst (sweep backs up the OS watcher)", async () => {
    const dir = makeRoot("claude")
    const seen: string[] = []
    const w = await startHookWatcher({
      dir,
      agents: claude,
      coalesceMs: 10,
      sweepMs: 40,
      onBatch: (b) => b.forEach((e) => seen.push(e.sessionId)),
    })
    try {
      for (let i = 0; i < 60; i++) {
        fs.writeFileSync(
          path.join(dir, "claude", `p.${i}.0.x.json`),
          JSON.stringify({ hook_event_name: "PreToolUse", session_id: "s" + i }),
        )
      }
      await waitUntil(() => new Set(seen).size === 60, 8000)
      await new Promise((r) => setTimeout(r, 120)) // a few more sweeps: no late duplicates
      expect(new Set(seen).size).toBe(60) // none dropped…
      expect(seen).toHaveLength(60) // …and each delivered exactly once (watcher + sweep claim)
    } finally {
      await w.close()
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
    }
  })

  it("skips a corrupt (non-JSON) drop without emitting", async () => {
    const dir = makeRoot("claude")
    const batches: AgentEvent[][] = []
    const w = await startHookWatcher({
      dir,
      agents: claude,
      onBatch: (b) => batches.push(b),
      coalesceMs: 10,
    })
    try {
      fs.writeFileSync(path.join(dir, "claude", "pane-1.1.1.x.json"), "not json{")
      await waitUntil(() => fs.readdirSync(path.join(dir, "claude")).length === 0) // consumed
      await new Promise((r) => setTimeout(r, 60)) // give any (wrong) batch a chance to fire
      expect(batches.flat()).toHaveLength(0)
    } finally {
      await w.close()
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
    }
  })

  it("carries SessionStart source, SessionEnd reason and the permission mode (resume ledger)", () => {
    const ev = normalizeHookEvent(
      {
        hook_event_name: "SessionStart",
        session_id: "s",
        source: "resume",
        permission_mode: "plan",
      },
      "p",
    )
    expect(ev).toMatchObject({ source: "resume", permissionMode: "plan" })
    expect(
      normalizeHookEvent({ hook_event_name: "SessionEnd", session_id: "s", reason: "other" })
        ?.reason,
    ).toBe("other")
  })
})
