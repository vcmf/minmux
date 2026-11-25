// OpenCode's MCP servers and skills (verified 2026-11-25, opencode 1.18): our plugin's tool
// events name each call. An MCP tool is `<server>_<tool>` (matched against the configured
// servers: names hold `_` too); a skill is the `skill` tool, whose name the plugin sends. What
// it has comes from its config files' `mcp` key and its skill folders. Counted per session in
// main from the events it already gets; a Toolbox goes out when the session starts and on each
// Stop.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import type { AgentEvent } from "../../src/lib/agent-graph"
import { bump, emptyKit, kitName, nameList, toToolbox, type Kit } from "./toolbox"

/** JSON with comments and trailing commas (OpenCode's .jsonc) → JSON text. */
export function stripJsonc(src: string): string {
  let out = ""
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!
    if (c === '"') {
      const start = i
      for (i++; i < src.length && src[i] !== '"'; i++) if (src[i] === "\\") i++
      out += src.slice(start, i + 1)
    } else if (c === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") i++
      out += "\n"
    } else if (c === "/" && src[i + 1] === "*") {
      i += 2
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++
      i++
    } else out += c
  }
  return out.replace(/,(\s*[}\]])/g, "$1")
}

const CONFIG_NAMES = ["opencode.json", "opencode.jsonc", "config.json"]
const SKILL_DIRS = ["skill", "skills"]

/** OpenCode's config files and skill folders for a session's folder: global
 *  (`~/.config/opencode`) and the project's (`<cwd>`, `<cwd>/.opencode`). Files are parsed once
 *  per change (by mtime). */
export class OpencodeConfig {
  private cache = new Map<string, { mtime: number; servers: string[] }>()
  constructor(private readonly home: string = os.homedir()) {}

  private dirs(cwd: string | undefined) {
    const global = path.join(
      process.env.XDG_CONFIG_HOME || path.join(this.home, ".config"),
      "opencode",
    )
    return [global, ...(cwd ? [cwd, path.join(cwd, ".opencode")] : [])]
  }

  private async serversIn(file: string): Promise<string[] | undefined> {
    try {
      const st = await fs.promises.stat(file)
      const hit = this.cache.get(file)
      if (hit && hit.mtime === st.mtimeMs) return hit.servers
      if (st.size > 4 * 1024 * 1024) return undefined
      const o = JSON.parse(stripJsonc(await fs.promises.readFile(file, "utf8"))) as {
        mcp?: unknown
      }
      const servers =
        o?.mcp && typeof o.mcp === "object"
          ? Object.keys(o.mcp)
              .map(kitName)
              .filter((n): n is string => !!n)
          : []
      this.cache.set(file, { mtime: st.mtimeMs, servers })
      return servers
    } catch {
      return undefined
    }
  }

  // (a session's answers are reused for half a minute: tool calls come in bursts)
  private recent = new Map<string, { at: number; servers?: string[]; skills?: string[] }>()
  private fresh(cwd: string | undefined) {
    const key = cwd ?? ""
    const now = Date.now()
    let r = this.recent.get(key)
    if (!r || now - r.at >= 30_000) {
      if (this.recent.size >= 64) this.recent.delete(this.recent.keys().next().value!)
      this.recent.set(key, (r = { at: now }))
    }
    return r
  }

  /** The configured servers (undefined: no config file read). */
  async servers(cwd: string | undefined): Promise<string[] | undefined> {
    const r = this.fresh(cwd)
    if ("servers" in r) return r.servers
    r.servers = await this.readServers(cwd)
    return r.servers
  }

  /** The skills in its skill folders (each `<dir>/<name>/SKILL.md`). */
  async skills(cwd: string | undefined): Promise<string[]> {
    const r = this.fresh(cwd)
    return (r.skills ??= await this.readSkills(cwd))
  }

  private async readServers(cwd: string | undefined): Promise<string[] | undefined> {
    let read = false
    const out: string[] = []
    for (const d of this.dirs(cwd))
      for (const n of CONFIG_NAMES) {
        const s = await this.serversIn(path.join(d, n))
        if (s) {
          read = true
          out.push(...s)
        }
      }
    return read ? nameList(out) : undefined
  }

  private async readSkills(cwd: string | undefined): Promise<string[]> {
    const out: string[] = []
    for (const d of this.dirs(cwd))
      for (const s of SKILL_DIRS) {
        try {
          for (const e of await fs.promises.readdir(path.join(d, s), { withFileTypes: true }))
            if (e.isDirectory()) {
              const n = kitName(e.name)
              const has = await fs.promises.access(path.join(d, s, e.name, "SKILL.md")).then(
                () => true,
                () => false,
              )
              if (n && has) out.push(n)
            }
        } catch {
          // no such folder
        }
      }
    return nameList(out)
  }
}

/** The configured server an MCP tool name belongs to (the longest that prefixes it). */
export function opencodeServerOf(tool: string, servers: string[]): string | undefined {
  let best: string | undefined
  for (const s of servers)
    if (tool.startsWith(`${s}_`) && (!best || s.length > best.length)) best = s
  return best
}

/** Per session: its counts, folder and the config it was started with. */
export class OpencodeToolbox {
  private sessions = new Map<string, { kit: Kit; cwd?: string }>()
  constructor(private readonly config = new OpencodeConfig()) {}

  /** A batch of OpenCode's events → the Toolbox events they call for. */
  async events(batch: AgentEvent[]): Promise<AgentEvent[]> {
    const out: AgentEvent[] = []
    for (const ev of batch) {
      if (ev.event === "SessionEnd" && !ev.agentId) {
        this.sessions.delete(ev.sessionId)
        continue
      }
      let s = this.sessions.get(ev.sessionId)
      if (!s) {
        if (ev.event !== "SessionStart" && ev.event !== "PreToolUse" && ev.event !== "Stop")
          continue
        if (this.sessions.size >= 256) this.sessions.delete(this.sessions.keys().next().value!)
        this.sessions.set(ev.sessionId, (s = { kit: emptyKit, cwd: ev.cwd }))
      }
      s.cwd ??= ev.cwd
      if (ev.event === "PreToolUse" && ev.toolName) {
        if (ev.toolName === "skill") {
          const name = kitName(ev.skill)
          if (name) s.kit = { ...s.kit, skills: bump(s.kit.skills, name) }
        } else {
          const server = opencodeServerOf(ev.toolName, (await this.config.servers(s.cwd)) ?? [])
          if (server) s.kit = { ...s.kit, mcp: bump(s.kit.mcp, server) }
        }
      }
      if ((ev.event === "SessionStart" || ev.event === "Stop") && !ev.agentId) {
        const [servers, skills] = await Promise.all([
          this.config.servers(s.cwd),
          this.config.skills(s.cwd),
        ])
        const kit = { ...s.kit, skillsLoaded: nameList([...skills, ...Object.keys(s.kit.skills)]) }
        out.push({ event: "Toolbox", sessionId: ev.sessionId, toolbox: toToolbox(kit, servers) })
      }
    }
    return out
  }
}
