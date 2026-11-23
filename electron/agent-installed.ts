// Which coding agents are installed here: the new-tab menu's "Agents" group. A few stats on
// main's PATH (the login shell's) per ask, off the terminal hot path; an answer is kept a
// minute (an agent installed or removed meanwhile shows then).

import path from "node:path"
import { AGENT_KINDS, agentsOn, type InstalledAgent } from "../src/lib/agent-kinds"

const TTL_MS = 60_000

export interface InstalledDeps {
  platform: string
  home: string
  /** `cmd`'s full path on PATH, or null. */
  onPath(cmd: string): Promise<string | null>
  isFile(p: string): Promise<boolean>
  now(): number
}

/** A lookup with its cache: call it per menu open. */
export function agentInstallLookup(deps: InstalledDeps): () => Promise<InstalledAgent[]> {
  const cache = new Map<InstalledAgent["kind"], { found: InstalledAgent | null; at: number }>()
  const check = async (kind: InstalledAgent["kind"]): Promise<InstalledAgent | null> => {
    const c = cache.get(kind)
    if (c && deps.now() - c.at < TTL_MS) return c.found
    const info = AGENT_KINDS[kind]
    let found: InstalledAgent | null = (await deps.onPath(info.command)) ? { kind } : null
    for (const rel of info.installPaths ?? []) {
      if (found) break
      // Off PATH (an rc alias may not exist in the shell that opens): typed by its full path.
      const full = path.join(deps.home, rel)
      if (await deps.isFile(full)) found = { kind, path: full }
    }
    cache.set(kind, { found, at: deps.now() })
    return found
  }
  return async () => {
    // Windows: the agents run inside WSL, whose PATH isn't main's — not looked up there (yet).
    if (deps.platform === "win32") return []
    const found = await Promise.all(agentsOn(deps.platform).map(check))
    return found.filter((a): a is InstalledAgent => a !== null)
  }
}
