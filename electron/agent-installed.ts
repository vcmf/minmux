// Which coding agents are installed here: the new-tab menu's "Agents" group. A few stats on
// main's PATH (the login shell's) per ask, off the terminal hot path; a found agent stays
// found, a miss is looked up again after a minute (installed meanwhile).

import path from "node:path"
import type { AgentKind } from "../src/lib/agent-graph"
import { AGENT_KINDS, agentsOn } from "../src/lib/agent-kinds"

const MISS_TTL_MS = 60_000

export interface InstalledDeps {
  platform: string
  home: string
  /** `cmd`'s full path on PATH, or null. */
  onPath(cmd: string): Promise<string | null>
  isFile(p: string): Promise<boolean>
  now(): number
}

/** A lookup with its cache: call it per menu open. */
export function agentInstallLookup(deps: InstalledDeps): () => Promise<AgentKind[]> {
  const cache = new Map<AgentKind, { found: boolean; at: number }>()
  const check = async (kind: AgentKind): Promise<boolean> => {
    const c = cache.get(kind)
    if (c && (c.found || deps.now() - c.at < MISS_TTL_MS)) return c.found
    const info = AGENT_KINDS[kind]
    let found = (await deps.onPath(info.command)) !== null
    for (const rel of info.installPaths ?? []) {
      if (found) break
      found = await deps.isFile(path.join(deps.home, rel))
    }
    cache.set(kind, { found, at: deps.now() })
    return found
  }
  return async () => {
    // Windows: the agents run inside WSL, whose PATH isn't main's — not looked up there (yet).
    if (deps.platform === "win32") return []
    const kinds = agentsOn(deps.platform)
    const found = await Promise.all(kinds.map(check))
    return kinds.filter((_, i) => found[i])
  }
}
