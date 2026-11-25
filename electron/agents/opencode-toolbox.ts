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
import { bump, emptyKit, kitName, nameList, toToolbox, wireName, type Kit } from "./toolbox"

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
    } else if (c === ",") {
      // (a trailing comma, outside strings: dropped)
      let j = i + 1
      for (;;) {
        while (j < src.length && /\s/.test(src[j]!)) j++
        if (src[j] === "/" && src[j + 1] === "/") while (j < src.length && src[j] !== "\n") j++
        else if (src[j] === "/" && src[j + 1] === "*") {
          j = src.indexOf("*/", j + 2)
          j = j < 0 ? src.length : j + 2
        } else break
      }
      if (src[j] !== "}" && src[j] !== "]") out += c
    } else out += c
  }
  return out
}

const PROJECT_CONFIG = ["opencode.json", "opencode.jsonc"]
const GLOBAL_CONFIG = [...PROJECT_CONFIG, "config.json"]
const SKILL_DIRS = ["skill", "skills"]

type McpLayer = Record<string, { enabled?: unknown }>

/** A parsed config's `mcp` entries (the layer they add). */
export function mcpLayer(o: unknown): McpLayer {
  const mcp = (o as { mcp?: unknown } | null)?.mcp
  if (!mcp || typeof mcp !== "object" || Array.isArray(mcp)) return {}
  const out: McpLayer = {}
  for (const [k, v] of Object.entries(mcp as Record<string, unknown>)) {
    const n = kitName(k)
    if (n) out[n] = v && typeof v === "object" ? (v as { enabled?: unknown }) : {}
  }
  return out
}

/** The servers of config layers merged as OpenCode merges them (a later one's fields win, so
 *  one can turn off, or back on, an earlier one's server). */
export function opencodeServersOf(layers: McpLayer[]): string[] {
  const merged: McpLayer = {}
  for (const l of layers) for (const [k, v] of Object.entries(l)) merged[k] = { ...merged[k], ...v }
  return Object.keys(merged).filter((k) => merged[k]!.enabled !== false)
}

/** OpenCode's config layers and skill folders for a session (FLEET_GRAPH.md, step 5). */
export class OpencodeConfig {
  private cache = new Map<string, { mtime: number; layer: McpLayer }>()
  constructor(
    private readonly home: string = os.homedir(),
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  private global() {
    return path.join(this.env.XDG_CONFIG_HOME || path.join(this.home, ".config"), "opencode")
  }

  /** The folders from `cwd` up to its repo root (the one with .git), nearest first. */
  private async project(cwd: string | undefined): Promise<string[]> {
    if (!cwd) return []
    const out: string[] = []
    for (let d = path.resolve(cwd), i = 0; i < 32; i++) {
      out.push(d)
      const git = await fs.promises.access(path.join(d, ".git")).then(
        () => true,
        () => false,
      )
      const up = path.dirname(d)
      if (git || up === d || d === this.home) break
      d = up
    }
    return out
  }

  private async layerIn(file: string): Promise<McpLayer | undefined> {
    try {
      const st = await fs.promises.stat(file)
      const hit = this.cache.get(file)
      if (hit && hit.mtime === st.mtimeMs) return hit.layer
      if (st.size > 4 * 1024 * 1024) return undefined
      const layer = mcpLayer(JSON.parse(stripJsonc(await fs.promises.readFile(file, "utf8"))))
      if (this.cache.size >= 128) this.cache.delete(this.cache.keys().next().value!)
      this.cache.set(file, { mtime: st.mtimeMs, layer })
      return layer
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

  /** The configured servers (undefined: no config read). */
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

  // Lowest first, as OpenCode layers them: global, OPENCODE_CONFIG, the project from its repo
  // root down to the folder (each `.opencode/` over its folder), OPENCODE_CONFIG_DIR, then
  // OPENCODE_CONFIG_CONTENT.
  private async readServers(cwd: string | undefined): Promise<string[] | undefined> {
    const layers: McpLayer[] = []
    const add = (l: McpLayer | undefined) => void (l && layers.push(l))
    for (const n of GLOBAL_CONFIG) add(await this.layerIn(path.join(this.global(), n)))
    if (this.env.OPENCODE_CONFIG) add(await this.layerIn(this.env.OPENCODE_CONFIG))
    for (const d of (await this.project(cwd)).reverse())
      for (const dir of [d, path.join(d, ".opencode")])
        for (const n of PROJECT_CONFIG) add(await this.layerIn(path.join(dir, n)))
    if (this.env.OPENCODE_CONFIG_DIR)
      for (const n of PROJECT_CONFIG)
        add(await this.layerIn(path.join(this.env.OPENCODE_CONFIG_DIR, n)))
    const inline = this.env.OPENCODE_CONFIG_CONTENT
    if (inline)
      try {
        add(mcpLayer(JSON.parse(stripJsonc(inline))))
      } catch {
        // not JSON: nothing from it
      }
    return layers.length ? nameList(opencodeServersOf(layers)) : undefined
  }

  private async readSkills(cwd: string | undefined): Promise<string[]> {
    const roots = [
      ...SKILL_DIRS.map((s) => path.join(this.global(), s)),
      ...(this.env.OPENCODE_CONFIG_DIR
        ? SKILL_DIRS.map((s) => path.join(this.env.OPENCODE_CONFIG_DIR!, s))
        : []),
      path.join(this.home, ".claude", "skills"),
    ]
    for (const d of await this.project(cwd))
      roots.push(
        ...SKILL_DIRS.map((s) => path.join(d, ".opencode", s)),
        path.join(d, ".claude", "skills"),
      )
    const out: string[] = []
    for (const root of roots) {
      try {
        for (const e of await fs.promises.readdir(root, { withFileTypes: true }))
          if (e.isDirectory() || e.isSymbolicLink()) {
            const n = kitName(e.name)
            const has = await fs.promises.access(path.join(root, e.name, "SKILL.md")).then(
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

/** The configured server an MCP tool name belongs to: the longest whose wire name (OpenCode
 *  writes `[^A-Za-z0-9_-]` as `_`) prefixes it. */
export function opencodeServerOf(tool: string, servers: string[]): string | undefined {
  let best: string | undefined
  for (const s of servers)
    if (tool.startsWith(`${wireName(s)}_`) && (!best || s.length > best.length)) best = s
  return best
}

/** Per session: its counts and folder. Kept across a switch away and back (OpenCode keeps no
 *  file to count them again from); the oldest go past 256 sessions. */
export class OpencodeToolbox {
  private sessions = new Map<string, { kit: Kit; cwd?: string }>()
  private chain: Promise<unknown> = Promise.resolve()
  constructor(private readonly config = new OpencodeConfig()) {}

  /** A batch of OpenCode's events → the Toolbox events they call for. Batches run one at a
   *  time, so a snapshot never goes out after a newer one. */
  events(batch: AgentEvent[]): Promise<AgentEvent[]> {
    const run = this.chain.then(() => this.run(batch))
    this.chain = run.catch(() => {})
    return run
  }

  private async run(batch: AgentEvent[]): Promise<AgentEvent[]> {
    const out: AgentEvent[] = []
    for (const ev of batch) {
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
        // (a name the model asked for isn't proof the skill exists: loaded is the folders' list)
        const kit = { ...s.kit, skillsLoaded: skills }
        out.push({ event: "Toolbox", sessionId: ev.sessionId, toolbox: toToolbox(kit, servers) })
      }
    }
    return out
  }
}
