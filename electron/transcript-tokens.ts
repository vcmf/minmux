// Token accounting from Claude Code transcripts. Hooks don't carry token counts, but every
// hook payload references a transcript JSONL whose assistant lines each embed a `message.usage`
// block. We fold those — incrementally (only the bytes appended since the last read) so a
// growing transcript never re-scans, and in bounded chunks that yield to the event loop so a
// large first read (e.g. a `claude --resume`d 30 MB+ file) can't stall PTY forwarding. The
// result is `context` (the LATEST turn's input = current window fill) + cumulative `output`.
//
// NOTE (stability): Claude documents this JSONL as an INTERNAL format that may change between
// releases. This parse is deliberately best-effort — if `message.usage` is renamed/reshaped a
// future version simply yields 0 (no badge) rather than erroring. Revisit if Claude ships a
// supported token source (OTEL, or usage in the hook payload itself).

import { TranscriptFold } from "./transcript-fold"
import type { TokenUsage } from "../src/lib/agent-graph"

export type { TokenUsage }

export const emptyUsage: TokenUsage = { context: 0, output: 0 }

/** A finite number from untrusted JSON, else 0. */
export const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0)

/** Fold one transcript line into `acc` (pure). `context` is OVERWRITTEN to this line's total
 *  input (input + cache read + cache create) — so after folding a whole read it reflects the
 *  LATEST assistant turn's context size; `output` ACCUMULATES. Non-assistant / unparseable
 *  lines (incl. a partial tail line) are no-ops, leaving `context` at the last real turn. */
export function addLine(acc: TokenUsage, line: string): TokenUsage {
  const t = line.trim()
  if (!t) return acc
  let o: unknown
  try {
    o = JSON.parse(t)
  } catch {
    return acc
  }
  if (typeof o !== "object" || o === null) return acc
  const rec = o as { type?: unknown; message?: unknown }
  if (rec.type !== "assistant" || typeof rec.message !== "object" || rec.message === null)
    return acc
  const u = (rec.message as { usage?: unknown }).usage
  if (typeof u !== "object" || u === null) return acc
  const g = u as Record<string, unknown>
  return {
    context:
      num(g.input_tokens) + num(g.cache_read_input_tokens) + num(g.cache_creation_input_tokens),
    output: acc.output + num(g.output_tokens),
  }
}

/** Incremental per-transcript token accumulator (context = latest turn, output = cumulative).
 *  See TranscriptFold for the chunked, event-loop-friendly read. */
export class TranscriptTokens extends TranscriptFold<TokenUsage> {
  constructor(chunkBytes?: number) {
    super(addLine, emptyUsage, chunkBytes)
  }
}
