import { describe, it, expect } from "vitest"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { startHookWatcher, normalizeHookEvent } from "./agent-hooks"
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
      event: "PreToolUse",
      sessionId: "s1",
      paneId: "pane-7",
      agentId: "a1",
      agentType: "Explore",
      cwd: "/repo",
      toolName: "Read",
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

describe("startHookWatcher", () => {
  it("parses a dropped event file, tags the pane from its name, deletes it, and batches", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "minmux-watch-"))
    const batches: AgentEvent[][] = []
    const w = await startHookWatcher({ dir, onBatch: (b) => batches.push(b), coalesceMs: 10 })
    try {
      const file = path.join(dir, "pane-9.111.222.abc.json")
      fs.writeFileSync(
        file,
        JSON.stringify({ hook_event_name: "SessionStart", session_id: "s1", cwd: "/repo" }),
      )
      await waitUntil(() => batches.length > 0)
      expect(batches.flat()).toHaveLength(1)
      expect(batches.flat()[0]).toMatchObject({
        event: "SessionStart",
        sessionId: "s1",
        paneId: "pane-9", // parsed from the filename prefix
        cwd: "/repo",
      })
      // the drop file is consumed (read + deleted)
      await waitUntil(() => fs.readdirSync(dir).length === 0)
    } finally {
      await w.close()
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("delivers every event under a burst (sweep backs up the OS watcher)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "minmux-watch-"))
    const seen = new Set<string>()
    const w = await startHookWatcher({
      dir,
      coalesceMs: 10,
      sweepMs: 40,
      onBatch: (b) => b.forEach((e) => seen.add(e.sessionId)),
    })
    try {
      for (let i = 0; i < 60; i++) {
        fs.writeFileSync(
          path.join(dir, `p.${i}.0.x.json`),
          JSON.stringify({ hook_event_name: "PreToolUse", session_id: "s" + i }),
        )
      }
      await waitUntil(() => seen.size === 60, 8000)
      expect(seen.size).toBe(60) // none dropped, none double-counted
    } finally {
      await w.close()
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("skips a corrupt (non-JSON) drop without emitting", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "minmux-watch-"))
    const batches: AgentEvent[][] = []
    const w = await startHookWatcher({ dir, onBatch: (b) => batches.push(b), coalesceMs: 10 })
    try {
      fs.writeFileSync(path.join(dir, "pane-1.1.1.x.json"), "not json{")
      await waitUntil(() => fs.readdirSync(dir).length === 0) // still consumed
      await new Promise((r) => setTimeout(r, 60)) // give any (wrong) batch a chance to fire
      expect(batches.flat()).toHaveLength(0)
    } finally {
      await w.close()
      fs.rmSync(dir, { recursive: true, force: true })
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
