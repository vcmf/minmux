// Codex's MCP servers, from its rollout and its config (verified 2026-11-25, codex-cli 0.167):
// each call is an `event_msg` `item_completed` whose item is a `McpToolCall` (`server`, `tool`,
// `status`: one refused for want of approval is `failed`). The rollout doesn't list the servers
// it has, so they come from `<codex home>/config.toml` (`[mcp_servers.<name>]`). Skills: not
// supported yet (no skill tool to see a use by).
import fs from "node:fs"
import path from "node:path"
import { bump, kitName, nameList, type Kit } from "./toolbox"

/** Fold one rollout line into the kit (pure; the same kit when the line says nothing). */
export function addCodexKitLine(acc: Kit, line: string): Kit {
  if (!line.includes('"McpToolCall"')) return acc // (most lines: no parse)
  let o: unknown
  try {
    o = JSON.parse(line)
  } catch {
    return acc
  }
  const rec = o as { type?: unknown; payload?: { type?: unknown; item?: unknown } } | null
  if (rec?.type !== "event_msg" || rec.payload?.type !== "item_completed") return acc
  const item = rec.payload.item as { type?: unknown; server?: unknown; status?: unknown } | null
  if (item?.type !== "McpToolCall") return acc
  const server = kitName(item.server)
  if (!server) return acc
  return item.status === "failed"
    ? { ...acc, mcpFailed: bump(acc.mcpFailed, server) }
    : { ...acc, mcp: bump(acc.mcp, server) }
}

const KEY = String.raw`(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_-]+))`
const pick = (m: RegExpExecArray, at = 1) => kitName(m[at] ?? m[at + 1] ?? m[at + 2])

/** The servers a config.toml gives Codex: `[mcp_servers.<name>]` tables, `<name> = {…}` under
 *  a bare `[mcp_servers]`, or root `mcp_servers.<name>.… =` keys; one with `enabled = false`
 *  is left out. A line reader, not a TOML parser: enough for these shapes. */
export function codexServersIn(toml: string): string[] {
  const found: string[] = []
  const off = new Set<string>()
  const table = new RegExp(String.raw`^\[\s*mcp_servers\.${KEY}\s*(\]|\.)`)
  const bare = /^\[\s*mcp_servers\s*\]/
  const header = /^\[/
  const inline = new RegExp(String.raw`^${KEY}\s*=\s*\{(.*)`)
  const under = new RegExp(String.raw`^${KEY}\s*\.\s*([A-Za-z_]+)\s*=\s*(.*)`)
  const dotted = new RegExp(String.raw`^mcp_servers\.${KEY}\s*\.\s*([A-Za-z_]+)\s*=\s*(.*)`)
  let where: { server?: string; bare?: boolean; root: boolean } = { root: true }
  for (const raw of toml.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith("#")) continue
    let m: RegExpExecArray | null
    if ((m = table.exec(line))) {
      const n = pick(m)
      if (n) found.push(n)
      // (a sub-table's `enabled` is a tool's or an env's, not the server's)
      where = { server: m[4] === "]" ? n : undefined, root: false }
    } else if (bare.test(line)) where = { bare: true, root: false }
    else if (header.test(line)) where = { root: false }
    else if (where.bare && (m = inline.exec(line))) {
      const n = pick(m)
      if (n) {
        found.push(n)
        if (/\benabled\s*=\s*false\b/.test(m[4] ?? "")) off.add(n)
      }
    } else if (where.bare && (m = under.exec(line))) {
      const n = pick(m)
      if (n) {
        found.push(n)
        if (m[4] === "enabled" && /^false\b/.test(m[5] ?? "")) off.add(n)
      }
    } else if (where.root && (m = dotted.exec(line))) {
      const n = pick(m)
      if (n) {
        found.push(n)
        if (m[4] === "enabled" && /^false\b/.test(m[5] ?? "")) off.add(n)
      }
    } else if (where.server && /^enabled\s*=\s*false\b/.test(line)) off.add(where.server)
  }
  return nameList(found.filter((n) => !off.has(n)))
}

/** Codex's home for a rollout (`<home>/sessions/YYYY/MM/DD/rollout-….jsonl`); null if not one. */
export function codexHomeOf(rollout: string | undefined): string | null {
  if (!rollout) return null
  const i = rollout.replace(/\\/g, "/").lastIndexOf("/sessions/")
  return i > 0 ? rollout.slice(0, i) : null
}

/** The servers in a Codex home's config.toml, read once per change (by mtime); undefined when
 *  it can't be read. */
export class CodexMcpConfig {
  private cache = new Map<string, { mtime: number; servers: string[] }>()

  async servers(home: string | null): Promise<string[] | undefined> {
    if (!home) return undefined
    const file = path.join(home, "config.toml")
    try {
      const st = await fs.promises.stat(file)
      const hit = this.cache.get(file)
      if (hit && hit.mtime === st.mtimeMs) return hit.servers
      const servers = codexServersIn(await fs.promises.readFile(file, "utf8"))
      this.cache.set(file, { mtime: st.mtimeMs, servers })
      return servers
    } catch (e) {
      // (no config.toml: none configured; one it can't read: unknown)
      return (e as NodeJS.ErrnoException).code === "ENOENT" ? [] : undefined
    }
  }
}
