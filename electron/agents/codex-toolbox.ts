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

/** The servers a config.toml names: `[mcp_servers.<name>]` tables (and their sub-tables). */
export function codexServersIn(toml: string): string[] {
  const out: string[] = []
  const re = /^\s*\[\s*mcp_servers\.(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_-]+))/gm
  for (let m = re.exec(toml); m; m = re.exec(toml)) {
    const n = kitName(m[1] ?? m[2] ?? m[3])
    if (n) out.push(n)
  }
  return nameList(out)
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
    } catch {
      return [] // (no config.toml: no servers configured)
    }
  }
}
