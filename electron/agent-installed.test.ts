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
    expect(await agentInstallLookup(d)()).toEqual(["claude", "opencode"])
  })

  it("finds Claude's old local install off PATH", async () => {
    const { d } = deps({ files: new Set(["/home/u/.claude/local/claude"]) })
    expect(await agentInstallLookup(d)()).toEqual(["claude"])
  })

  it("looks nothing up on Windows", async () => {
    const { d, calls } = deps({ platform: "win32", path: new Set(["claude"]) })
    expect(await agentInstallLookup(d)()).toEqual([])
    expect(calls).toEqual([])
  })

  it("keeps a hit, and looks a miss up again after a minute", async () => {
    let now = 0
    const path = new Set(["claude"])
    const { d, calls } = deps({ path, now: () => now })
    const lookup = agentInstallLookup(d)
    await lookup()
    expect(calls).toEqual(["claude", "codex", "opencode"])
    calls.length = 0
    path.add("codex")
    now = 30_000
    expect(await lookup()).toEqual(["claude"]) // the miss is still cached
    expect(calls).toEqual([])
    now = 61_000
    expect(await lookup()).toEqual(["claude", "codex"])
    expect(calls).toEqual(["codex", "opencode"]) // the hit wasn't looked up again
  })
})
