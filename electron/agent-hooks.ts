// File-drop watcher for Claude Code hooks (M6). Claude writes each event as a file into
// a watched directory (see electron/hook-writer.ts); we read + delete each file, normalise
// it off any hot path, and forward coalesced batches to the renderer (which holds the
// AgentGraph and runs the pure reducer). No HTTP server, no port — so nothing can go stale
// (the old loopback receiver's ECONNREFUSED class) and it works across the WSL boundary,
// where a Windows-loopback server is unreachable. See docs/design/AGENT_OBSERVABILITY.md.

import fs from "node:fs"
import path from "node:path"
import { watch } from "chokidar"
import type { AgentEvent } from "../src/lib/agent-graph"

// tool_input keys that carry a file path, across the file-touching tools.
const FILE_TOOL_KEYS = ["file_path", "path", "notebook_path"] as const

/** Raw hook JSON (+ the pane id parsed from the drop file's name) → the normalised
 *  AgentEvent; null if the payload lacks the minimum (event name + session id). */
export function normalizeHookEvent(raw: unknown, paneId?: string): AgentEvent | null {
  if (typeof raw !== "object" || raw === null) return null
  const r = raw as Record<string, unknown>
  if (typeof r.hook_event_name !== "string" || typeof r.session_id !== "string") return null
  const ti = (typeof r.tool_input === "object" && r.tool_input ? r.tool_input : {}) as Record<
    string,
    unknown
  >
  const filePath = FILE_TOOL_KEYS.map((k) => ti[k]).find((v) => typeof v === "string") as
    string | undefined
  const str = (v: unknown) => (typeof v === "string" ? v : undefined)
  return {
    agent: "claude",
    event: r.hook_event_name,
    sessionId: r.session_id,
    paneId: paneId || undefined,
    agentId: str(r.agent_id),
    agentType: str(r.agent_type),
    cwd: str(r.cwd),
    toolName: str(r.tool_name),
    filePath,
    message: str(r.message) ?? str(r.last_assistant_message),
    worktreePath: str(r.worktree_path),
    baseBranch: str(r.base_branch),
    transcriptPath: str(r.transcript_path),
    agentTranscriptPath: str(r.agent_transcript_path),
    source: str(r.source),
    reason: str(r.reason),
    permissionMode: str(r.permission_mode),
  }
}

export interface HookWatcher {
  close: () => Promise<void>
}

export interface HookWatcherOptions {
  dir: string // the drop directory to watch (must already exist)
  onBatch: (events: AgentEvent[]) => void // coalesced, off any hot path
  coalesceMs?: number // batch window (default 50ms) — one emit per window
  sweepMs?: number // safety-net directory rescan (default 750ms)
}

const MAX_DROP_BYTES = 1024 * 1024 // ignore a pathologically large drop (bound main memory)

/** Watch `dir` for event files; claim + parse + delete each, tag it with the pane id from
 *  the filename, and forward coalesced batches. A periodic sweep re-scans the dir so a burst
 *  the OS watcher coalesced/dropped is still picked up (guaranteed-ish delivery); the rename
 *  claim makes watcher + sweep consume each file exactly once. Best-effort per file. */
export async function startHookWatcher(opts: HookWatcherOptions): Promise<HookWatcher> {
  const coalesceMs = opts.coalesceMs ?? 50
  // Each drop is read asynchronously, so files finish out of order; keep the drop timestamp
  // (from the filename) and deliver a batch sorted by it — Start/End pairs stay in order.
  let pending: { ev: AgentEvent; ts: number }[] = []
  let timer: ReturnType<typeof setTimeout> | null = null

  const flush = () => {
    timer = null
    if (pending.length === 0) return
    const batch = pending.sort((a, b) => a.ts - b.ts).map((p) => p.ev)
    pending = []
    try {
      opts.onBatch(batch)
    } catch {
      // a consumer error must never take down the watcher
    }
  }
  const schedule = () => {
    if (!timer) timer = setTimeout(flush, coalesceMs)
  }

  // Claim a drop by renaming it (atomic) → only one of {watcher, sweep} wins, so an event
  // is never delivered twice. Size-cap it, parse, emit, then remove the claimed file.
  const ingest = (file: string) => {
    if (!file.endsWith(".json")) return // skip our own .rd claim files + anything else
    const claim = `${file}.rd`
    void fs.promises
      .rename(file, claim)
      .then(async () => {
        try {
          const st = await fs.promises.stat(claim)
          if (st.size > MAX_DROP_BYTES) return // oversized — drop it, don't read into memory
          let raw: unknown
          try {
            raw = JSON.parse(await fs.promises.readFile(claim, "utf8"))
          } catch {
            return // partial/corrupt drop — skip
          }
          // Filename is `<paneId>.<pid>.<ts>.<rand>.json`; pane ids are UUIDs (no dots).
          const parts = path.basename(file).split(".")
          const paneId = parts[0] || undefined
          const ev = normalizeHookEvent(raw, paneId)
          if (ev) {
            const ts = Number(parts[2])
            pending.push({ ev, ts: Number.isFinite(ts) ? ts : Date.now() })
            schedule()
          }
        } finally {
          void fs.promises.rm(claim, { force: true }).catch(() => {})
        }
      })
      .catch(() => {}) // rename failed ⇒ already claimed or gone ⇒ skip (dedup)
  }

  const sweep = () => {
    void fs.promises
      .readdir(opts.dir)
      .then((files) => {
        for (const f of files) if (f.endsWith(".json")) ingest(path.join(opts.dir, f))
      })
      .catch(() => {})
  }

  // awaitWriteFinish so we don't claim a half-written drop; ignoreInitial since the caller
  // clears stale files before starting (a leftover would replay an old event otherwise).
  const watcher = watch(opts.dir, {
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 30, pollInterval: 10 },
  })
  watcher.on("add", ingest)
  await new Promise<void>((resolve) => watcher.on("ready", () => resolve()))
  const sweepTimer = setInterval(sweep, opts.sweepMs ?? 750)

  return {
    close: async () => {
      clearInterval(sweepTimer)
      if (timer) clearTimeout(timer)
      flush() // deliver the final (<coalesceMs) window instead of dropping it
      await watcher.close()
    },
  }
}
