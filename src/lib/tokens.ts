// Renderer-safe token display helpers (no fs — the summing lives in electron/transcript-tokens).
import type { TokenUsage } from "./agent-graph"

/** Compact human count: 1_234 → "1.2k", 4_500_000 → "4.5M". */
export function formatTokens(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) {
    const k = n / 1000
    return `${k < 10 ? k.toFixed(1) : Math.round(k)}k`
  }
  const m = n / 1_000_000
  return `${m < 10 ? m.toFixed(1) : Math.round(m)}M`
}

/** Tooltip: "↑ 148k context · ↓ 7.4M generated", plus "(57% of 258k)" when the window is known. */
export function tokenBreakdown(u: TokenUsage): string {
  const of = u.window
    ? ` (${Math.min(100, Math.round((u.context / u.window) * 100))}% of ${formatTokens(u.window)})`
    : ""
  return `↑ ${formatTokens(u.context)} context${of} · ↓ ${formatTokens(u.output)} generated`
}
