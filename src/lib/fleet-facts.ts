// Short facts about an agent session for the Fleet's cards and panel: its folder's name, its
// model's short name, its context window. Pure.
import type { AgentKind, TokenUsage } from "./agent-graph"

/** A folder's last name (`~` for the home folder's own). */
export function folderName(cwd: string | undefined): string | undefined {
  if (!cwd) return undefined
  const parts = cwd.replace(/[\\/]+$/, "").split(/[\\/]/)
  return parts[parts.length - 1] || cwd
}

/** A model id made short: no vendor prefix, no date suffix (`claude-opus-4-5-20250101` → `opus-4-5`). */
export function shortModel(model: string | undefined): string | undefined {
  if (!model) return undefined
  return model
    .replace(/^(anthropic\/|openai\/)?claude-/, "")
    .replace(/-\d{8}$/, "")
    .replace(/^[a-z-]+\//, "")
}

/** A session's context window: the agent's own word, else Claude's (200k; 1M once past it). */
export function contextWindow(kind: AgentKind, t: TokenUsage | undefined): number | undefined {
  if (!t) return undefined
  if (t.window) return t.window
  if (kind !== "claude") return undefined
  return t.context > 200_000 || /\[1m\]|-1m\b/i.test(t.model ?? "") ? 1_000_000 : 200_000
}

/** Tokens as `82k` (or `1.2M`). */
export const kTokens = (n: number) =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M` : `${Math.round(n / 1000)}k`
