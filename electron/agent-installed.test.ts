import { describe, expect, it } from "vitest"
import { agentInstallLookup, type InstalledDeps } from "./agent-installed"

function deps(over: Partial<InstalledDeps> & { path?: Set<string>; files?: Set<string> }) {
  const calls: string[] = []
  const d: InstalledDeps = {
    platform: "darwin",
    home: "/home/u",
    onPath: async (cmd) => {
      calls.push(cmd)
      return over.path?.has(cmd) ? `/usr/bin/${cmd}` : null
    },
    isFile: async (p) => over.files?.has(p) ?? false,
    now: () => 0,
    ...over,
  }
  return { d, calls }
}

describe("agentInstallLookup", () => {
  it("lists the agents on PATH, in the registry's order", async () => {
    const { d } = deps({ path: new Set(["opencode", "claude"]) })
    expect(await agentInstallLookup(d)()).toEqual([{ kind: "claude" }, { kind: "opencode" }])
  })

  it("finds Claude's old local install off PATH, by its full path", async () => {
    const { d } = deps({ files: new Set(["/home/u/.claude/local/claude"]) })
    expect(await agentInstallLookup(d)()).toEqual([
      { kind: "claude", path: "/home/u/.claude/local/claude" },
    ])
  })

  it("prefers PATH over the local install (no path to type)", async () => {
    const files = new Set(["/home/u/.claude/local/claude"])
    const { d } = deps({ path: new Set(["claude"]), files })
    expect(await agentInstallLookup(d)()).toEqual([{ kind: "claude" }])
  })

  it("looks nothing up on Windows", async () => {
    const { d, calls } = deps({ platform: "win32", path: new Set(["claude"]) })
    expect(await agentInstallLookup(d)()).toEqual([])
    expect(calls).toEqual([])
  })

  it("keeps an answer a minute, then looks again (installed or removed meanwhile)", async () => {
    let now = 0
    const path = new Set(["claude"])
    const { d, calls } = deps({ path, now: () => now })
    const lookup = agentInstallLookup(d)
    await lookup()
    expect(calls).toEqual(["claude", "codex", "opencode"])
    calls.length = 0
    path.add("codex")
    path.delete("claude")
    now = 30_000
    expect(await lookup()).toEqual([{ kind: "claude" }]) // still cached
    expect(calls).toEqual([])
    now = 61_000
    expect(await lookup()).toEqual([{ kind: "codex" }])
  })
})
