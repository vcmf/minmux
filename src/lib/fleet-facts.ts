// Short facts about an agent session for the Fleet's cards and panel: its folder's name, its
// model's short name, its context window. Pure; agent specifics come from agent-kinds.
import type { AgentKind, TokenUsage } from "./agent-graph"
import { AGENT_KINDS } from "./agent-kinds"

/** A folder's last name. */
export function folderName(cwd: string | undefined): string | undefined {
  if (!cwd) return undefined
  const parts = cwd.replace(/[\\/]+$/, "").split(/[\\/]/)
  return parts[parts.length - 1] || cwd
}

/** A model id made short: no vendor prefix or path, no date suffix. */
export function shortModel(kind: AgentKind, model: string | undefined): string | undefined {
  if (!model) return undefined
  // (a provider's path or region prefix, `openai/`, `us.anthropic.`; a date, `-20251101` or
  // `@20251101`; a Bedrock version, `-v1:0`)
  let m = model.replace(/^[a-z0-9-]+\//i, "").replace(/^([a-z]{2}\.)?anthropic\./i, "")
  m = m.replace(/-v\d+(:\d+)?$/, "").replace(/[-@]\d{8}$/, "")
  const prefix = AGENT_KINDS[kind].modelPrefix ?? AGENT_KINDS.claude.modelPrefix
  // (any agent's Claude model is shown alike)
  return prefix && m.startsWith(prefix) ? m.slice(prefix.length) : m
}

/** A session's context window: its agent's own word, else its kind's usual one (a guess). */
export function contextWindow(
  kind: AgentKind,
  t: TokenUsage | undefined,
): { size: number; guess: boolean } | undefined {
  if (!t) return undefined
  if (t.window) return { size: t.window, guess: false }
  const w = AGENT_KINDS[kind].window
  if (!w) return undefined
  return { size: t.context > w.usual ? w.large : w.usual, guess: true }
}

/** The checkout a PR or branch card names: an agent's on it if any, else the first; and how
 *  many others it's checked out in. */
export function shownDir(
  dirs: string[],
  agents: { dir?: string }[],
): { dir: string; more: number } | undefined {
  if (!dirs.length) return undefined
  const dir = dirs.find((d) => agents.some((a) => a.dir === d)) ?? dirs[0]!
  return { dir, more: dirs.length - 1 }
}
