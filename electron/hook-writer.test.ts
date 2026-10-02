import { describe, it, expect } from "vitest"
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { HOOK_WRITER, buildHookSettings } from "./hook-writer"

describe("buildHookSettings", () => {
  const s = JSON.parse(buildHookSettings()) as {
    hooks: Record<
      string,
      Array<{
        matcher?: string
        hooks: Array<{ type: string; args: string[]; async?: boolean; timeout?: number }>
      }>
    >
  }
  it("emits a command hook that runs the writer for the claude folder, with no path", () => {
    const h = s.hooks.SessionStart![0]!.hooks[0]!
    expect(h.type).toBe("command")
    expect(h.args[0]).toBe("-e")
    expect(h.args[2]).toBe("claude") // the agent is argv[1] to `node -e`; the root is in the env
    expect(buildHookSettings()).toBe(buildHookSettings()) // byte-stable: one file, native + WSL
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
  const run = (agent: string, env: Record<string, string>) => {
    const base = { ...process.env }
    delete base.MINMUX_AGENT_EVENTS // a real "unset", not the string "undefined"
    execFileSync("node", ["-e", HOOK_WRITER, agent], {
      input: JSON.stringify({ hook_event_name: "PreToolUse", session_id: "s1" }),
      env: { ...base, ...env },
    })
  }
  const withRoot = (fn: (root: string) => void) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "minmux-hw-"))
    fs.mkdirSync(path.join(root, "claude"))
    try {
      fn(root)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  }

  it("writes stdin into <root>/<agent>/ as a pane-id-prefixed file the watcher can parse", () =>
    withRoot((root) => {
      run("claude", { MINMUX_AGENT_EVENTS: root, MINMUX_PANE_ID: "pane-1" })
      const files = fs.readdirSync(path.join(root, "claude"))
      expect(files).toHaveLength(1)
      expect(files[0]!.split(".")[0]).toBe("pane-1") // filename prefix = pane id
      expect(
        JSON.parse(fs.readFileSync(path.join(root, "claude", files[0]!), "utf8")),
      ).toMatchObject({ session_id: "s1" })
    }))

  it("writes nothing outside a minmux pane (no drop root in the env)", () =>
    withRoot((root) => {
      run("claude", { MINMUX_PANE_ID: "pane-1" })
      expect(fs.readdirSync(path.join(root, "claude"))).toEqual([])
    }))

  it("refuses an agent name that isn't a plain folder name", () =>
    withRoot((root) => {
      run("../claude", { MINMUX_AGENT_EVENTS: path.join(root, "claude") })
      run("", { MINMUX_AGENT_EVENTS: root })
      expect(fs.readdirSync(root)).toEqual(["claude"])
      expect(fs.readdirSync(path.join(root, "claude"))).toEqual([])
    }))
})
