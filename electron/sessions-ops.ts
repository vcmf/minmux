// The sessions worker's requests (sessions-worker.ts): list one agent's past sessions, search
// their conversations. Pure of Electron, so tests drive it directly.

import type { AgentKind } from "../src/lib/agent-graph"
import { filterPast, type SessionHit } from "../src/lib/past-sessions"
import type { ListedSession, SessionChecker } from "./agents/types"
import type { AgentHistory } from "./agents/history-index"
import { searchFiles, type SearchFile } from "./session-search"

export type SessionsRequest =
  | { id: number; op: "list"; agent: AgentKind }
  | {
      id: number
      op: "search"
      query: string
      agents: AgentKind[]
      rg: string | null
      under?: string // only sessions in this folder or below
    }
  | { id: number; op: "cancel" }
  | { id: number; op: "touched"; agent: AgentKind; sessionId: string }

export interface SearchDone {
  capped: boolean // stopped at the most sessions it shows
  timedOut?: boolean
  couldNot?: AgentKind[] // agents whose store couldn't be searched
}

export type SessionsReply =
  | { id: number; ok: true; value: ListedSession[] | SearchDone | number | null }
  | { id: number; ok: false; code: string }
  | { id: number; hit: SessionHit }

export const SEARCH_MS = 20_000
const REUSE_MS = 5_000 // a search reuses a listing this recent

export class SessionsOps {
  private searches = new Map<number, AbortController>()

  constructor(
    private readonly agents: Partial<Record<AgentKind, AgentHistory>>,
    private readonly post: (reply: SessionsReply) => void,
  ) {}

  handle(req: SessionsRequest): void {
    if (req.op === "cancel") return this.searches.get(req.id)?.abort()
    const run =
      req.op === "list"
        ? this.list(req.agent)
        : req.op === "touched"
          ? this.touched(req.agent, req.sessionId)
          : this.search(req)
    void run.then(
      (value) => this.post({ id: req.id, ok: true, value }),
      (e: unknown) =>
        this.post({ id: req.id, ok: false, code: String((e as Error)?.message ?? e) }),
    )
  }

  // A listing is shared while it runs, and a search reuses one this recent: typing doesn't walk
  // every transcript folder once per keystroke.
  private listed = new Map<AgentKind, { at: number; rows: Promise<ListedSession[]> }>()

  private list(agent: AgentKind, maxAgeMs = 0): Promise<ListedSession[]> {
    const had = this.listed.get(agent)
    if (had && (had.at === 0 || Date.now() - had.at <= maxAgeMs)) return had.rows
    const entry = { at: 0, rows: Promise.resolve([] as ListedSession[]) }
    entry.rows = (this.agents[agent]?.history.list() ?? Promise.resolve([])).then(
      (rows) => {
        entry.at = Date.now()
        return rows
      },
      (e: unknown) => {
        this.listed.delete(agent)
        throw e
      },
    )
    this.listed.set(agent, entry)
    return entry.rows
  }

  /** When a session was last written, from its agent's own store (null: it can't say). */
  private async touched(agent: AgentKind, sessionId: string): Promise<number | null> {
    return (await this.agents[agent]?.own?.touched(sessionId)) ?? null
  }

  private async search(req: Extract<SessionsRequest, { op: "search" }>): Promise<SearchDone> {
    const ctl = new AbortController()
    this.searches.set(req.id, ctl)
    let timer: ReturnType<typeof setTimeout> | undefined
    const checkers = new Map<AgentKind, SessionChecker>()
    let timedOut = false
    try {
      // The listed sessions (cached reads), newest first across agents.
      // An agent whose store can't even be listed can't be searched: named, never "no matches".
      const failed = new Set<AgentKind>()
      const lists = await Promise.all(
        req.agents.map((a) =>
          this.list(a, REUSE_MS).catch(() => {
            if (this.agents[a]?.own) failed.add(a)
            return [] as ListedSession[]
          }),
        ),
      )
      const rows = filterPast(lists.flat(), new Set(req.agents), req.under).sort(
        (a, b) => b.updatedAt - a.updatedAt,
      )
      const byKey = new Map(rows.map((s) => [`${s.agent}:${s.sessionId}`, s]))
      // Newest first across agents: a transcript file, or (no file) the agent's own store.
      const files: SearchFile[] = rows.flatMap((s) =>
        s.transcriptPath
          ? [{ agent: s.agent, sessionId: s.sessionId, file: s.transcriptPath }]
          : this.agents[s.agent]?.own
            ? [{ agent: s.agent, sessionId: s.sessionId }]
            : [],
      )
      // Each hit carries its row: main records it for a resume, the tab shows it even if its
      // own list is older (main strips the file path on the way).
      const post = (hit: SessionHit) => {
        const session = byKey.get(`${hit.agent}:${hit.sessionId}`)
        if (session) this.post({ id: req.id, hit: { ...hit, session } })
      }
      // One checker a store for this search (an open database), closed at the end. A store
      // that can't be searched is named, never read as "no matches".
      for (const a of new Set(files.filter((f) => !f.file).map((f) => f.agent))) {
        try {
          const c = this.agents[a]?.own?.searcher(req.query)
          if (c) checkers.set(a, c)
        } catch {
          failed.add(a)
        }
      }
      // The time allowed runs from here: a slow first listing isn't counted against the search.
      timer = setTimeout(() => {
        timedOut = true
        ctl.abort()
      }, SEARCH_MS)
      const { capped } = await searchFiles(files, req.query, {
        rg: req.rg,
        signal: ctl.signal,
        texts: (agent, line) => this.agents[agent]?.texts?.(line) ?? [],
        quick: (agent, raw) => this.agents[agent]?.quick?.(raw) ?? false,
        own: (f) => {
          const c = checkers.get(f.agent)
          if (!c || failed.has(f.agent)) return undefined
          try {
            return c.check(f.sessionId)
          } catch {
            failed.add(f.agent) // the store went wrong mid-search: say so, stop asking it
            return undefined
          }
        },
        onHit: post,
      })
      return {
        capped,
        ...(timedOut ? { timedOut } : {}),
        ...(failed.size ? { couldNot: [...failed] } : {}),
      }
    } finally {
      clearTimeout(timer)
      for (const c of checkers.values()) c.close()
      this.searches.delete(req.id)
    }
  }
}
