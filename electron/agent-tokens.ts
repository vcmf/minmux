// Bridges hook events → token totals. On a turn/sub-agent finish we read the referenced
// transcript (incrementally) and emit a synthetic `TokenUsage` AgentEvent the renderer's pure
// reducer folds onto the matching node. Runs on the hook channel in the main process, off the
// terminal hot path — see startAgentObservability.

import type { AgentEvent, TokenUsage } from "../src/lib/agent-graph"
import type { TranscriptFold } from "./transcript-fold"

/** Host-fs candidate paths for a transcript path the agent reported. Identity on same-OS
 *  runs; on WSL the agent's Linux path resolves to the pane's distro's UNC shares (see main —
 *  `paneId` selects the right distro). */
export type ResolvePath = (transcriptPath: string, paneId?: string) => string[]

const identity: ResolvePath = (p) => [p]

/** A sub-agent's transcript from the session transcript + agent id. Claude stores it at
 *  `<session-transcript-without-.jsonl>/subagents/agent-<agentId>.jsonl` (verified on disk);
 *  deriving it avoids depending on an undocumented `agent_transcript_path` hook field. Uses
 *  forward slashes (Node accepts them on Windows too; on WSL the path is POSIX anyway). */
export function subagentTranscriptPath(
  sessionTranscriptPath: string | undefined,
  agentId: string,
): string | null {
  if (!sessionTranscriptPath) return null
  const base = sessionTranscriptPath.replace(/\.jsonl$/i, "")
  if (base === sessionTranscriptPath) return null // not the expected .jsonl layout → unknown
  return `${base}/subagents/agent-${agentId}.jsonl`
}

/** Which events to price, and which transcript to read for each:
 *   - Stop         → the session transcript  → the session root
 *   - SubagentStop → the sub-agent transcript → that sub-agent
 * SessionEnd frees the session transcript's accumulator. `resolve` maps the agent-reported
 * path to reachable host paths (WSL translation); state stays keyed by the reported path.
 *
 * Caveats (both eventually-consistent / graceful, documented for reviewers):
 *   - The transcript is written asynchronously and may lag the in-memory conversation, so a
 *     read on Stop can miss the just-ended turn's last line → the total trails by up to a turn
 *     and self-heals on the next Stop (a sub-agent stops once, so its badge may sit one turn low).
 *   - TokenUsage is emitted as a follow-up batch after the hook events; if a later
 *     UserPromptSubmit prunes a finished sub-agent before its (slow) read lands, the reducer's
 *     no-resurrection guard drops it and no badge appears. Narrow — sub-agent transcripts are
 *     small so the read is fast; the session root is never pruned, only evicted on SessionEnd. */
export async function tokenEventsForBatch(
  tracker: TranscriptFold<TokenUsage>, // the agent's transcript reader (Claude's, Codex's…)
  batch: AgentEvent[],
  resolve: ResolvePath = identity,
): Promise<AgentEvent[]> {
  const out: AgentEvent[] = []
  for (const ev of batch) {
    if (ev.event === "SessionEnd" && ev.transcriptPath) {
      tracker.forget(ev.transcriptPath)
      continue
    }
    // Session turn finished → price the session transcript against the root.
    if (ev.event === "Stop" && ev.transcriptPath) {
      const tokens = await tracker.update(ev.transcriptPath, resolve(ev.transcriptPath, ev.paneId))
      out.push({ event: "TokenUsage", sessionId: ev.sessionId, tokens })
    }
    // Sub-agent finished → price its own transcript against that sub-agent, then free the
    // accumulator (a sub-agent stops exactly once, so its state is never read again).
    if (ev.event === "SubagentStop" && ev.agentId) {
      const txPath = ev.agentTranscriptPath ?? subagentTranscriptPath(ev.transcriptPath, ev.agentId)
      if (txPath) {
        const tokens = await tracker.update(txPath, resolve(txPath, ev.paneId))
        out.push({ event: "TokenUsage", sessionId: ev.sessionId, agentId: ev.agentId, tokens })
        tracker.forget(txPath)
      }
    }
  }
  return out
}
