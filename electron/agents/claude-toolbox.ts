// Claude's MCP servers and skills, from its transcript (verified 2026-11-25): the
// `skill_listing` attachment lists the skills it has, `deferred_tools_delta` the MCP tools it
// can load (`mcp__<server>__<tool>`) and the servers that failed; an assistant `tool_use` named
// `mcp__…` or `Skill` (its `input.skill`) is a use. Servers that load all their tools up front
// aren't in the transcript: the config files fill those in (claudeMcpConfig).
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Worker } from "node:worker_threads"
import { TranscriptFold } from "../transcript-fold"
import { bump, emptyKit, kitName, nameList, withTool, type Kit } from "./toolbox"

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
      // (by name: a tool announced again after a compaction isn't one more)
      const note = (list: unknown, add: boolean) => {
        if (!Array.isArray(list)) return
        for (const t of list)
          if (typeof t === "string" && !SIGN_IN.test(t)) {
            const s = mcpServerOf(t)
            const tool = kitName(t)
            if (s && tool) tools = withTool(tools, s, tool, add)
          }
      }
      note(a.addedNames, true)
      note(a.readdedNames, true)
      note(a.removedNames, false)
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

/** The MCP servers named in a parsed config object's `mcpServers`. */
const serversIn = (o: unknown): string[] => {
  const m = (o as { mcpServers?: unknown } | null)?.mcpServers
  return m && typeof m === "object"
    ? Object.keys(m)
        .map(kitName)
        .filter((n): n is string => !!n)
    : []
}

/** The uses each of a session's sub-agents made, by agent id, from their transcripts
 *  (`<session>/subagents/agent-<id>.jsonl`): read in chunks, off the agent's loop. */
export async function claudeSubagentUses(transcriptPath: string): Promise<Map<string, Kit>> {
  const out = new Map<string, Kit>()
  const dir = transcriptPath.replace(/\.jsonl$/i, "")
  if (dir === transcriptPath) return out
  let files: string[]
  try {
    files = (await fs.promises.readdir(path.join(dir, "subagents"))).slice(0, 512)
  } catch {
    return out
  }
  const fold = new TranscriptFold<Kit>(addClaudeKitLine, emptyKit)
  for (const f of files) {
    const id = /^agent-(.+)\.jsonl$/.exec(f)?.[1]
    if (!id) continue
    const p = path.join(dir, "subagents", f)
    out.set(id, await fold.update(p))
    fold.forget(p)
  }
  return out
}

/** What minmux needs from `~/.claude.json`: the user's servers and, per project, its servers
 *  and the switches that turn them on or off. Small, whatever the file's size. */
export interface ClaudeDigest {
  user: string[]
  projects: Record<string, ClaudeProject>
}
interface ClaudeProject {
  servers: string[]
  disabled: string[] // disabledMcpServers + disabledMcpjsonServers
  approved: string[] // enabledMcpjsonServers
  all?: boolean // enableAllProjectMcpServers
}

// The worker that reads and digests ~/.claude.json: the file can be many MB (Claude keeps each
// project's history in it) and Claude rewrites it nearly every turn, so it's never parsed on
// main's thread, which forwards the terminals. One worker, made when first needed, never
// keeping the app alive.
// (plain JS, self-contained: bundling renames whatever a function's source would refer to)
const WORKER_SRC = String.raw`
const { parentPort } = require("node:worker_threads")
const fs = require("node:fs")
const name = (v) => (typeof v === "string" && v.trim() ? v.trim().slice(0, 128) : undefined)
const names = (v) =>
  v && typeof v === "object" && !Array.isArray(v) ? Object.keys(v).map(name).filter(Boolean) : []
const strs = (v) => (Array.isArray(v) ? v.map(name).filter(Boolean) : [])
function digest(o) {
  const root = o && typeof o === "object" ? o : {}
  const projects = {}
  if (root.projects && typeof root.projects === "object")
    for (const [k, v] of Object.entries(root.projects)) {
      const p = v && typeof v === "object" ? v : {}
      projects[k] = {
        servers: names(p.mcpServers),
        disabled: [...strs(p.disabledMcpServers), ...strs(p.disabledMcpjsonServers)],
        approved: strs(p.enabledMcpjsonServers),
        all: p.enableAllProjectMcpServers === true,
      }
    }
  return { user: names(root.mcpServers), projects }
}
parentPort.on("message", ({ id, file }) => {
  let out = null
  try {
    out = digest(JSON.parse(fs.readFileSync(file, "utf8")))
  } catch {}
  parentPort.postMessage({ id, out })
})
`

class DigestWorker {
  private current: { w: Worker; waiting: Map<number, (d: ClaudeDigest | null) => void> } | null =
    null
  private ids = 0
  read(file: string): Promise<ClaudeDigest | null> {
    try {
      if (!this.current) {
        const w = new Worker(WORKER_SRC, { eval: true })
        w.unref()
        // (each worker answers only its own reads: a dead one's late exit can't touch the next)
        const mine = { w, waiting: new Map<number, (d: ClaudeDigest | null) => void>() }
        w.on("message", (m: { id: number; out: ClaudeDigest | null }) => {
          mine.waiting.get(m.id)?.(m.out)
          mine.waiting.delete(m.id)
        })
        const fail = () => {
          for (const done of mine.waiting.values()) done(null)
          mine.waiting.clear()
          if (this.current === mine) this.current = null
        }
        w.on("error", fail)
        w.on("exit", fail)
        this.current = mine
      }
      const { w, waiting } = this.current
      const id = ++this.ids
      return new Promise((done) => {
        waiting.set(id, done)
        w.postMessage({ id, file })
      })
    } catch {
      return Promise.resolve(null)
    }
  }
}

const REUSE_MS = 30_000

/** The servers Claude's config gives a session: user-wide and per project in `~/.claude.json`
 *  (under CLAUDE_CONFIG_DIR when set), and the project's `.mcp.json` (the nearest, up to the
 *  repo root) when approved there or in a settings file. Read off main's thread; a reading is
 *  reused for half a minute (staleness is harmless). Undefined when nothing could be read. */
export class ClaudeMcpConfig {
  private digests = new Map<string, { mtime: number; at: number; d: ClaudeDigest | null }>()
  private small = new Map<string, { mtime: number; json: unknown }>()
  private worker = new DigestWorker()
  constructor(
    private readonly home: string = os.homedir(),
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  private configDir = () => this.env.CLAUDE_CONFIG_DIR || path.join(this.home, ".claude")
  private userFile = () =>
    this.env.CLAUDE_CONFIG_DIR
      ? path.join(this.env.CLAUDE_CONFIG_DIR, ".claude.json")
      : path.join(this.home, ".claude.json")

  private async digest(): Promise<ClaudeDigest | null> {
    const file = this.userFile()
    const now = Date.now()
    const hit = this.digests.get(file)
    if (hit && now - hit.at < REUSE_MS) return hit.d
    try {
      const st = await fs.promises.stat(file)
      if (hit && hit.mtime === st.mtimeMs) {
        hit.at = now
        return hit.d
      }
      const d = await this.worker.read(file)
      // (a read that failed, most likely of a file Claude was rewriting, keeps the last good
      // one; the next read tries again)
      if (!d) return hit?.d ?? null
      this.digests.set(file, { mtime: st.mtimeMs, at: now, d })
      return d
    } catch {
      this.digests.delete(file)
      return null
    }
  }

  /** A small JSON file (a .mcp.json, a settings file), parsed once per change. */
  private async json(file: string): Promise<Record<string, unknown> | undefined> {
    try {
      const st = await fs.promises.stat(file)
      if (st.size > 1024 * 1024) return undefined
      const hit = this.small.get(file)
      if (hit && hit.mtime === st.mtimeMs) return hit.json as Record<string, unknown>
      const json = JSON.parse(await fs.promises.readFile(file, "utf8")) as unknown
      if (this.small.size >= 128) this.small.delete(this.small.keys().next().value!)
      this.small.set(file, { mtime: st.mtimeMs, json })
      return json as Record<string, unknown>
    } catch {
      return undefined
    }
  }

  /** `root` and its parents up to the repo root (the one with .git), nearest first. */
  private async upward(root: string): Promise<string[]> {
    const out: string[] = []
    for (let d = path.resolve(root), i = 0; i < 32; i++) {
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

  /** `root`: where the session started (its project). */
  async servers(root: string | undefined): Promise<string[] | undefined> {
    const d = await this.digest()
    const dirs = root ? await this.upward(root) : []
    // (Claude files a project under the folder it was started in: the nearest one it knows)
    const here = d ? dirs.map((x) => d.projects[x]).find(Boolean) : undefined
    let mcpJson: Record<string, unknown> | undefined
    let projectDir: string | undefined
    for (const x of dirs) {
      mcpJson = await this.json(path.join(x, ".mcp.json"))
      if (mcpJson) {
        projectDir = x
        break
      }
    }
    if (!d && !mcpJson) return undefined
    // Approval of the .mcp.json servers: ~/.claude.json's project entry, or a settings file.
    const settings = [
      await this.json(path.join(this.configDir(), "settings.json")),
      ...(projectDir
        ? [
            await this.json(path.join(projectDir, ".claude", "settings.json")),
            await this.json(path.join(projectDir, ".claude", "settings.local.json")),
          ]
        : []),
    ]
    const strs = (v: unknown) =>
      Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []
    const off = new Set([
      ...(here?.disabled ?? []),
      ...settings.flatMap((s) => strs(s?.disabledMcpjsonServers)),
    ])
    const approved = new Set([
      ...(here?.approved ?? []),
      ...settings.flatMap((s) => strs(s?.enabledMcpjsonServers)),
    ])
    const all = !!here?.all || settings.some((s) => s?.enableAllProjectMcpServers === true)
    const fromJson = serversIn(mcpJson).filter((s) => all || approved.has(s))
    return nameList([...(d?.user ?? []), ...(here?.servers ?? []), ...fromJson]).filter(
      (s) => !off.has(s),
    )
  }
}
