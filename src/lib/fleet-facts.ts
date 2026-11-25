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
  const prefix = AGENT_KINDS[kind].modelPrefix
  let m = model.replace(/^[a-z0-9-]+\//i, "")
  if (prefix && m.startsWith(prefix)) m = m.slice(prefix.length)
  return m.replace(/-\d{8}$/, "")
}

/** A session's context window: the agent's own word, else its kind's usual one, marked a guess
 *  (none when its kind has none). */
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
