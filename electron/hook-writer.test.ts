import { describe, it, expect } from "vitest"
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { HOOK_WRITER, buildHookSettings } from "./hook-writer"

describe("buildHookSettings", () => {
  const s = JSON.parse(buildHookSettings("/tmp/ev")) as {
    hooks: Record<
      string,
      Array<{
        matcher?: string
        hooks: Array<{ type: string; args: string[]; async?: boolean; timeout?: number }>
      }>
    >
  }
  it("emits a command hook that runs the writer with the events dir", () => {
    const h = s.hooks.SessionStart![0]!.hooks[0]!
    expect(h.type).toBe("command")
    expect(h.args[0]).toBe("-e")
    expect(h.args[2]).toBe("/tmp/ev") // the events dir is argv[1] to `node -e`
  })
  it("is async with a timeout backstop (can't hang the agent's tool loop)", () => {
    const h = s.hooks.SessionStart![0]!.hooks[0]!
    expect(h.async).toBe(true)
    expect(typeof h.timeout).toBe("number")
  })
  it("wraps tool events with a matcher, others without", () => {
    expect(s.hooks.PreToolUse![0]!.matcher).toBe("")
    expect(s.hooks.SessionStart![0]!.matcher).toBeUndefined()
  })
  it("covers the worktree + cwd events", () => {
    expect(s.hooks.WorktreeCreate).toBeDefined()
    expect(s.hooks.CwdChanged).toBeDefined()
  })
})

describe("HOOK_WRITER (end-to-end via node -e)", () => {
  it("writes stdin to a pane-id-prefixed file the watcher can parse", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "minmux-hw-"))
    const payload = JSON.stringify({ hook_event_name: "PreToolUse", session_id: "s1" })
    execFileSync("node", ["-e", HOOK_WRITER, dir], {
      input: payload,
      env: { ...process.env, MINMUX_PANE_ID: "pane-1" },
    })
    const files = fs.readdirSync(dir)
    expect(files).toHaveLength(1)
    expect(files[0]!.split(".")[0]).toBe("pane-1") // filename prefix = pane id
    expect(JSON.parse(fs.readFileSync(path.join(dir, files[0]!), "utf8"))).toMatchObject({
      session_id: "s1",
    })
    fs.rmSync(dir, { recursive: true, force: true })
  })
})
