// Live per-pane agent session metadata (name, colour) for the pane accent and the resume
// banner. Where it lives is the agent's (a MetaReader): Claude's `/color` + `/rename` in the
// session's own transcript (slash commands fire no hook), Codex's thread names in one index
// file shared by every session (each pane reads its own session's entry). Besides refreshing on
// the pane's hook events we watch that file and re-read (incrementally) on append — debounced,
// async, in the main process: nothing here touches the PTY → renderer path.
import fs from "node:fs"
import { TranscriptMeta, type SessionMeta } from "./transcript-meta"
import type { AgentEvent, AgentKind } from "../src/lib/agent-graph"

/** Start watching the first reachable candidate; `onChange` on writes, `onError` if the watch
 *  dies (file replaced, share hiccup). Returns a stop function, or null if nothing could be
 *  watched yet (hook events still refresh; the watch is retried, throttled). */
export type WatchFn = (
  candidates: string[],
  onChange: () => void,
  onError: () => void,
) => (() => void) | null

export const fsWatch: WatchFn = (candidates, onChange, onError) => {
  for (const c of candidates) {
    try {
      const w = fs.watch(c, { persistent: false }, onChange)
      w.on("error", () => {
        w.close()
        onError()
      })
      return () => w.close()
    } catch {
      // missing (transcript not created yet) / unwatchable (some WSL shares) — try the next
    }
  }
  return null
}

/** Where an agent keeps a session's name/colour: reads the file `key` (incrementally) and
 *  returns that session's meta. Claude: its own transcript; Codex: one shared index file. */
export interface MetaReader {
  update(key: string, candidates: string[], sessionId?: string): Promise<SessionMeta>
  forget(key: string): void
}

interface PaneWatch {
  key: string // the file the meta is read from (reader state key)
  sessionId?: string // the session it's for, when the file holds several (Codex's index)
  candidates: string[] // reachable host paths for it (WSL: UNC shares)
  stop: (() => void) | null
  lastWatchTry: number // ms — throttles re-trying an unwatchable file on every hook event
  timer?: ReturnType<typeof setTimeout>
  last?: SessionMeta
}

// An unwatchable file (WSL share) would otherwise re-run sync fs.watch attempts on every
// hook event of a tool-heavy turn.
const WATCH_RETRY_MS = 5000

const sameMeta = (a: SessionMeta | undefined, b: SessionMeta | undefined) =>
  a?.color === b?.color && a?.name === b?.name && a?.auto === b?.auto

const hasMeta = (m: SessionMeta | undefined) => !!m && (m.color !== undefined || !!m.name)

/** Tracks each pane's session meta from its agent's file and emits it on change (null = gone). */
export class AgentMetaTracker {
  private panes = new Map<string, PaneWatch>()

  constructor(
    // `sessionId`: whose meta it is (a null for the session a switch left isn't the new one's).
    private readonly emit: (paneId: string, meta: SessionMeta | null, sessionId?: string) => void,
    private readonly watch: WatchFn = fsWatch,
    private readonly debounceMs = 200,
    private readonly reader: MetaReader = new TranscriptMeta(), // Claude's: the session's file
    private readonly now: () => number = Date.now,
  ) {}

  /** A hook event from `paneId` naming where its session's meta lives: start (or refresh)
   *  tracking. Another file or session in the same pane = a new session → restart, clearing
   *  the old session's accent first (it may have died without a SessionEnd). */
  track(paneId: string, key: string, candidates: string[] = [key], sessionId?: string): void {
    let p = this.panes.get(paneId)
    if (p && p.key === key && p.sessionId !== sessionId) {
      // Same shared file, another session (Codex `/new`): keep the watch and what's been read of
      // the file, but as a fresh record — a refresh still running for the old session then can't
      // land on it — and clear the old session's accent now.
      clearTimeout(p.timer)
      const had = hasMeta(p.last)
      const left = p.sessionId
      p = { ...p, sessionId, last: undefined, timer: undefined }
      this.panes.set(paneId, p)
      if (had) this.emit(paneId, null, left)
    } else if (p && p.key !== key) {
      this.untrack(paneId)
      p = undefined
    }
    if (!p) {
      p = { key, sessionId, candidates, stop: null, lastWatchTry: -Infinity }
      this.panes.set(paneId, p)
    }
    this.ensureWatch(paneId, p)
    this.schedule(paneId)
  }

  /** The agent left the pane (SessionEnd) or the pane/PTY ended: stop watching, clear the
   *  accent. With `key` (and `sessionId`), only if that is still what's tracked — a late
   *  SessionEnd of the previous session (drops are ingested unordered) must not end the new. */
  untrack(paneId: string, notify = true, key?: string, sessionId?: string): void {
    const p = this.panes.get(paneId)
    if (!p || (key !== undefined && p.key !== key)) return
    if (sessionId !== undefined && p.sessionId !== undefined && p.sessionId !== sessionId) return
    p.stop?.()
    clearTimeout(p.timer)
    this.panes.delete(paneId)
    // A shared file (Codex's index) stays read for the other panes that track it.
    if (![...this.panes.values()].some((o) => o.key === p.key)) this.reader.forget(p.key)
    if (notify && hasMeta(p.last)) this.emit(paneId, null, p.sessionId)
  }

  /** Current metadata of every tracked pane — a freshly (re)loaded renderer has none. */
  snapshot(): [string, SessionMeta][] {
    const out: [string, SessionMeta][] = []
    for (const [id, p] of this.panes) if (hasMeta(p.last)) out.push([id, p.last!])
    return out
  }

  dispose(): void {
    for (const id of [...this.panes.keys()]) this.untrack(id, false)
  }

  private ensureWatch(paneId: string, p: PaneWatch): void {
    if (p.stop || this.now() - p.lastWatchTry < WATCH_RETRY_MS) return
    p.lastWatchTry = this.now()
    p.stop = this.watch(
      p.candidates,
      () => this.schedule(paneId),
      () => {
        // The watch died: drop it so the next event re-arms it (no throttle wait). The pane's
        // record may have been renewed (a session switch) but still holds this watch.
        const cur = this.panes.get(paneId)
        if (!cur || cur.key !== p.key) return
        cur.stop = null
        cur.lastWatchTry = -Infinity
      },
    )
  }

  // Coalesce bursts (a hook storm, or several appends while Claude writes a turn).
  private schedule(paneId: string): void {
    const p = this.panes.get(paneId)
    if (!p) return
    clearTimeout(p.timer)
    p.timer = setTimeout(() => void this.refresh(paneId, p), this.debounceMs)
  }

  private async refresh(paneId: string, p: PaneWatch): Promise<void> {
    const meta = await this.reader.update(p.key, p.candidates, p.sessionId)
    if (this.panes.get(paneId) !== p) return // untracked / restarted meanwhile
    if (sameMeta(meta, p.last)) return
    const had = hasMeta(p.last)
    p.last = meta
    if (hasMeta(meta)) this.emit(paneId, meta, p.sessionId)
    else if (had) this.emit(paneId, null, p.sessionId)
  }
}

/** What a batch of hook events asks of the per-agent meta trackers. */
export type MetaAction =
  | { type: "track" | "untrack"; kind: AgentKind; paneId: string; file: string; sessionId: string }
  | { type: "clear-others"; kind: AgentKind; paneId: string } // this agent leads the pane now

/** The tracker work for a batch (pure; main applies it). Only a pane's own session counts — a
 *  background agent (nested) inherits the pane but mustn't take its accent. `source` says which
 *  agent an event is from and the file its meta lives in (null: that agent keeps none, but it
 *  still leads the pane, so other agents' accents there go); null = not an armed agent. */
export function planMeta(
  events: AgentEvent[],
  source: (ev: AgentEvent) => { kind: AgentKind; file: string | null } | null,
): MetaAction[] {
  const out: MetaAction[] = []
  for (const ev of events) {
    if (!ev.paneId || ev.agentId || ev.nested) continue
    const src = source(ev)
    if (!src) continue
    const base = { kind: src.kind, paneId: ev.paneId }
    if (ev.event !== "SessionEnd") out.push({ type: "clear-others", ...base })
    if (!src.file) continue
    const where = { ...base, file: src.file, sessionId: ev.sessionId }
    out.push({ type: ev.event === "SessionEnd" ? "untrack" : "track", ...where })
  }
  return out
}
