// File-drop watcher for coding-agent hooks (M6). Each agent writes every event as a file into
// its own folder under a watched drop root (`<root>/<agent>/`, see electron/hook-writer.ts);
// we read + delete each file, normalise it with that agent's normaliser off any hot path, and
// forward coalesced batches to the renderer (which holds the AgentGraph and runs the pure
// reducer). No HTTP server, no port — so nothing can go stale (the old loopback receiver's
// ECONNREFUSED class) and it works across the WSL boundary, where a Windows-loopback server
// is unreachable. See docs/design/AGENT_OBSERVABILITY.md and MULTI_AGENT.md.

import fs from "node:fs"
import path from "node:path"
import { watch } from "chokidar"
import type { AgentEvent, AgentKind } from "../src/lib/agent-graph"

export interface HookWatcher {
  close: () => Promise<void>
}

/** A raw drop (parsed JSON + the pane id from its filename) → an event, or null to skip. */
export type DropNormalizer = (raw: unknown, paneId?: string) => AgentEvent | null

export interface HookWatcherOptions {
  dir: string // the drop root; each agent writes into `<dir>/<agent>/` (all must already exist)
  agents: Partial<Record<AgentKind, DropNormalizer>> // agent folder → its normaliser; others ignored
  onBatch: (events: AgentEvent[]) => void // coalesced, off any hot path
  coalesceMs?: number // batch window (default 50ms) — one emit per window
  sweepMs?: number // safety-net directory rescan (default 750ms)
}

const MAX_DROP_BYTES = 1024 * 1024 // ignore a pathologically large drop (bound main memory)

/** Watch each agent's folder under `dir` for event files; claim + parse + delete each,
 *  normalise it with its folder's normaliser (tagging the pane id from the filename), and
 *  forward coalesced batches. A periodic sweep re-scans the dir so a burst
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

  // Each agent's folder (normalised, so a caller's trailing separator or relative root can't
  // make every drop miss the lookup) → its normaliser.
  const byFolder = new Map<string, { kind: AgentKind; normalize: DropNormalizer }>()
  for (const [kind, normalize] of Object.entries(opts.agents) as [AgentKind, DropNormalizer][])
    byFolder.set(path.resolve(opts.dir, kind), { kind, normalize })
  const folders = [...byFolder.keys()]

  // Claim a drop by renaming it (atomic) → only one of {watcher, sweep} wins, so an event
  // is never delivered twice. Size-cap it, parse, emit, then remove the claimed file.
  const ingest = (file: string) => {
    if (!file.endsWith(".json")) return // skip our own .rd claim files + anything else
    // Only `<dir>/<known agent>/<drop>.json`: the folder names the agent; a file straight in
    // the root, a deeper one or an unknown folder is not ours (left alone).
    const agent = byFolder.get(path.dirname(path.resolve(file)))
    if (!agent) return
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
          let ev: AgentEvent | null = null
          try {
            const out = agent.normalize(raw, paneId)
            // The folder says which agent wrote it — never trust a normaliser to say so.
            ev = out && { ...out, agent: agent.kind }
          } catch {
            // a normaliser must never take down the watcher
          }
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
    for (const folder of folders)
      void fs.promises
        .readdir(folder)
        .then((files) => {
          for (const f of files) if (f.endsWith(".json")) ingest(path.join(folder, f))
        })
        .catch(() => {})
  }

  // Nothing to watch (no agent armed): chokidar would never report "ready" for no paths.
  if (folders.length === 0) return { close: async () => {} }

  // awaitWriteFinish so we don't claim a half-written drop; ignoreInitial since the caller
  // clears stale files before starting (a leftover would replay an old event otherwise).
  const watcher = watch(folders, {
    ignoreInitial: true,
    depth: 0,
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
