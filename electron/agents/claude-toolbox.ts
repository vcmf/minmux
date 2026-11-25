// Claude's MCP servers and skills, from its transcript (verified 2026-11-25): the
// `skill_listing` attachment lists the skills it has, `deferred_tools_delta` the MCP tools it
// can load (`mcp__<server>__<tool>`) and the servers that failed; an assistant `tool_use` named
// `mcp__…` or `Skill` (its `input.skill`) is a use. Servers that load all their tools up front
// aren't in the transcript: the config files fill those in (claudeMcpConfig).
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { bump, kitName, nameList, type Kit } from "./toolbox"

/** `mcp__<server>__<tool>` → its server as the user knows it (`claude_ai_X` → `claude.ai X`). */
export function mcpServerOf(tool: string): string | undefined {
  const m = /^mcp__(.+?)__(.+)$/.exec(tool)
  if (!m) return undefined
  const raw = m[1]!
  return kitName(
    raw.startsWith("claude_ai_") ? `claude.ai ${raw.slice(10).replace(/_/g, " ")}` : raw,
  )
}

// A connector's sign-in tools (listed while it isn't signed in): no sign it's there to use.
const SIGN_IN = /__(authenticate|complete_authentication)$/

/** Fold one transcript line into the kit (pure; the same kit when the line says nothing). */
export function addClaudeKitLine(acc: Kit, line: string): Kit {
  // (most lines are none of these: no parse for them)
  if (
    !line.includes('"skill_listing"') &&
    !line.includes('"deferred_tools_delta"') &&
    !line.includes('"mcp__') &&
    !line.includes('"Skill"')
  )
    return acc
  let o: unknown
  try {
    o = JSON.parse(line)
  } catch {
    return acc
  }
  if (typeof o !== "object" || o === null) return acc
  const rec = o as { type?: unknown; attachment?: unknown; message?: unknown }
  const a = rec.attachment as Record<string, unknown> | undefined
  if (a && typeof a === "object") {
    if (a.type === "skill_listing" && Array.isArray(a.names)) {
      const names = a.names.map(kitName).filter((n): n is string => !!n)
      const base = a.isInitial === true ? [] : (acc.skillsLoaded ?? [])
      return { ...acc, skillsLoaded: nameList([...base, ...names]) }
    }
    if (a.type === "deferred_tools_delta") {
      let tools = acc.mcpTools
      const count = (list: unknown, by: number) => {
        if (!Array.isArray(list)) return
        for (const t of list)
          if (typeof t === "string" && !SIGN_IN.test(t)) {
            const s = mcpServerOf(t)
            if (s) tools = bump(tools, s, by)
          }
      }
      count(a.addedNames, 1)
      count(a.readdedNames, 1)
      count(a.removedNames, -1)
      const failed = Array.isArray(a.failedMcpServers)
        ? a.failedMcpServers
            .map((f) => kitName(typeof f === "string" ? f : (f as { name?: unknown })?.name))
            .filter((n): n is string => !!n)
        : undefined
      if (tools === acc.mcpTools && !failed) return acc
      return { ...acc, mcpTools: tools, ...(failed ? { mcpDown: nameList(failed) } : {}) }
    }
    return acc
  }
  if (rec.type !== "assistant" || typeof rec.message !== "object" || rec.message === null)
    return acc
  const content = (rec.message as { content?: unknown }).content
  if (!Array.isArray(content)) return acc
  let out = acc
  for (const c of content) {
    if (typeof c !== "object" || c === null) continue
    const u = c as { type?: unknown; name?: unknown; input?: unknown }
    if (u.type !== "tool_use" || typeof u.name !== "string") continue
    const server = mcpServerOf(u.name)
    if (server) out = { ...out, mcp: bump(out.mcp, server) }
    else if (u.name === "Skill") {
      const skill = kitName((u.input as { skill?: unknown } | undefined)?.skill)
      if (skill) out = { ...out, skills: bump(out.skills, skill) }
    }
  }
  return out
}

const REUSE_MS = 30_000

/** The MCP servers named in a parsed config object's `mcpServers`. */
const serversIn = (o: unknown): string[] => {
  const m = (o as { mcpServers?: unknown } | null)?.mcpServers
  return m && typeof m === "object"
    ? Object.keys(m)
        .map(kitName)
        .filter((n): n is string => !!n)
    : []
}

/** The servers Claude's config gives a folder: `~/.claude.json` (user-wide and per project)
 *  and the folder's `.mcp.json`. Each file parsed once per change (by mtime); undefined when
 *  none could be read. */
export class ClaudeMcpConfig {
  private cache = new Map<string, { mtime: number; json: unknown; at: number }>()
  constructor(private readonly home: string = os.homedir()) {}

  // (Claude rewrites ~/.claude.json often, and a parse takes a few ms on main's thread, which
  // forwards the terminals: a reading is reused for half a minute, staleness being harmless)
  private async read(file: string): Promise<unknown> {
    const now = Date.now()
    const hit = this.cache.get(file)
    if (hit && now - hit.at < REUSE_MS) return hit.json
    try {
      const st = await fs.promises.stat(file)
      if (hit && hit.mtime === st.mtimeMs) {
        hit.at = now
        return hit.json
      }
      if (st.size > 64 * 1024 * 1024) return undefined // (not a config)
      const json = JSON.parse(await fs.promises.readFile(file, "utf8")) as unknown
      this.cache.set(file, { mtime: st.mtimeMs, json, at: now })
      return json
    } catch {
      this.cache.delete(file)
      return undefined
    }
  }

  async servers(cwd: string | undefined): Promise<string[] | undefined> {
    const user = await this.read(path.join(this.home, ".claude.json"))
    const project = cwd ? await this.read(path.join(cwd, ".mcp.json")) : undefined
    if (user === undefined && project === undefined) return undefined
    const projects = (user as { projects?: Record<string, unknown> } | undefined)?.projects
    const here = cwd && projects && typeof projects === "object" ? projects[cwd] : undefined
    return nameList([...serversIn(user), ...serversIn(here), ...serversIn(project)])
  }
}
