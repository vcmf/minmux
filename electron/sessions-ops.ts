// The sessions worker's requests (sessions-worker.ts): list one agent's past sessions, search
// their conversations. Pure of Electron, so tests drive it directly.

import type { AgentKind } from "../src/lib/agent-graph"
import { filterPast, type SessionHit } from "../src/lib/past-sessions"
import type { ListedSession, SessionChecker } from "./agents/types"
import type { AgentHistory } from "./agents/history-index"
import { matcher, searchFiles, snippetOf, type SearchFile } from "./session-search"
import { PORTS_MS, type AgentProc, type AgentProcsResult } from "../src/lib/agent-processes"
import { attributeAll, type Marker, type PaneRoots, type Snapshot } from "./proc-snapshot"
import type { Inventory } from "../src/lib/fleet-inventory"
import { scanInventory, type InventorySource } from "./inventory-scan"

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
  | { id: number; op: "inventory"; cacheFile: string }
  | { id: number; op: "touched"; agent: AgentKind; sessionId: string }
  | {
      id: number
      op: "procs"
      panes: PaneRoots[] // every local pane (what's in a pane's tree isn't detached)
      open: string[] // the panes whose lists are shown
      owned: string[] // every pane this minmux opened: only their leftovers are this one's
      uid: number
      agentNames: string[]
    }

export interface SearchDone {
  capped: boolean // stopped at the most sessions it shows
  timedOut?: boolean
  couldNot?: AgentKind[] // agents whose store couldn't be searched
}

export type SessionsReply =
  | {
      id: number
      ok: true
      value: ListedSession[] | SearchDone | number | null | AgentProcsResult | Inventory
    }
  | { id: number; ok: false; code: string }
  | { id: number; hit: SessionHit }

/** Every process, and the pane each one's environment names (proc-scan.ts). */
export type Scan = { snap: Snapshot; markers: Map<number, Marker> }

export const SEARCH_MS = 20_000
const REUSE_MS = 5_000 // a search reuses a listing this recent

export class SessionsOps {
  private searches = new Map<number, AbortController>()

  constructor(
    private readonly agents: Partial<Record<AgentKind, AgentHistory>>,
    private readonly post: (reply: SessionsReply) => void,
    private readonly scan: () => Promise<Scan> = () => Promise.reject(new Error("no process scan")),
    private readonly ports: (pids: number[]) => Promise<Map<number, number[]>> = async () =>
      new Map(),
    private readonly inventorySources: () => InventorySource[] = () => [],
  ) {}

  // One history scan at a time (a call while one runs shares it); a result this recent is
  // reused: switching windows or reopening the view doesn't scan again.
  private scanned: { at: number; file: string; value: Promise<Inventory> } | null = null
  private inventory(cacheFile: string): Promise<Inventory> {
    const s = this.scanned
    if (s && s.file === cacheFile && (s.at === 0 || Date.now() - s.at < 30_000)) return s.value
    const entry = { at: 0, file: cacheFile, value: Promise.resolve({} as Inventory) }
    entry.value = scanInventory(this.inventorySources(), cacheFile).then(
      (v) => {
        entry.at = Date.now()
        return v
      },
      (e: unknown) => {
        this.scanned = null
        throw e
      },
    )
    this.scanned = entry
    return entry.value
  }

  handle(req: SessionsRequest): void {
    if (req.op === "cancel") return this.searches.get(req.id)?.abort()
    const run = ((): Promise<Extract<SessionsReply, { ok: true }>["value"]> => {
      switch (req.op) {
        case "list":
          return this.list(req.agent)
        case "touched":
          return this.touched(req.agent, req.sessionId)
        case "procs":
          return this.procs(req)
        case "search":
          return this.search(req)
        case "inventory":
          return this.inventory(req.cacheFile)
      }
    })()
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

  // One snapshot at a time: a poll asked for while one runs shares it (never stacked).
  private snapshot: Promise<Scan> | null = null

  /** Per pane: the processes its agents run (docs/design/AGENT_PROCESSES.md). */
  private async procs(req: Extract<SessionsRequest, { op: "procs" }>): Promise<AgentProcsResult> {
    const { snap, markers } = await this.fresh()
    const { rows, leftovers } = attributeAll(
      snap,
      markers,
      req.panes,
      req.uid,
      new Set(req.agentNames),
      new Set(req.owned),
      new Set(req.open),
    )
    // Every open pane answered (empty when it has nothing, or its shell is gone).
    const panes = Object.fromEntries(req.open.map((id) => [id, rows[id] ?? []]))
    // Listening ports, for the processes shown (lsof, at most every PORTS_MS).
    const shown = [...Object.values(panes), ...Object.values(leftovers)].flat()
    const ports = await this.portsOf(shown)
    const withPorts = (list: AgentProc[]) =>
      list.map((p) => {
        const got = ports.get(`${p.pid}:${p.started}`)
        return got?.length ? { ...p, ports: got } : p
      })
    return {
      panes: Object.fromEntries(Object.entries(panes).map(([id, l]) => [id, withPorts(l)])),
      leftovers: Object.fromEntries(Object.entries(leftovers).map(([id, l]) => [id, withPorts(l)])),
    }
  }

  // Ports by process (pid and start: a reused pid isn't the same one), asked for at most every
  // PORTS_MS and again sooner when a new process is shown. A lookup running is shared when it
  // covers the processes asked for; a failed one counts as none until PORTS_MS (a broken lsof
  // isn't run on every poll).
  private portCache: { at: number; keys: Set<string>; ports: Map<string, number[]> } | null = null
  private portLookup: { keys: Set<string>; done: Promise<Map<string, number[]>> } | null = null
  private portSeq = 0
  private portSeqCached = 0

  private async portsOf(procs: AgentProc[]): Promise<Map<string, number[]>> {
    const keys = procs.map((p) => `${p.pid}:${p.started}`)
    const c = this.portCache
    if (c && Date.now() - c.at < PORTS_MS && keys.every((k) => c.keys.has(k))) return c.ports
    const l = this.portLookup
    if (l && keys.every((k) => l.keys.has(k))) return l.done
    const seq = ++this.portSeq
    const done = this.ports(procs.map((p) => p.pid))
      .then((byPid) => new Map(procs.map((p) => [`${p.pid}:${p.started}`, byPid.get(p.pid) ?? []])))
      .catch(() => new Map<string, number[]>())
      .then((ports) => {
        // A lookup that ends after a newer one doesn't replace its answer.
        if (seq > this.portSeqCached) {
          this.portCache = { at: Date.now(), keys: new Set(keys), ports }
          this.portSeqCached = seq
        }
        if (this.portLookup?.done === done) this.portLookup = null
        return ports
      })
    this.portLookup = { keys: new Set(keys), done }
    return done
  }

  private fresh() {
    this.snapshot ??= this.scan().finally(() => (this.snapshot = null))
    return this.snapshot
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
      // Each hit carries its row: main records it for a resume, the tab shows it even if its
      // own list is older (main strips the file path on the way).
      const post = (hit: SessionHit) => {
        const session = byKey.get(`${hit.agent}:${hit.sessionId}`)
        if (session) this.post({ id: req.id, hit: { ...hit, session } })
      }
      // Its name (a /rename, a thread or session title: what the list shows) counts too.
      const re = matcher(req.query)
      const byName = (f: SearchFile): SessionHit | undefined => {
        const name = byKey.get(`${f.agent}:${f.sessionId}`)?.name
        const m = name ? snippetOf(name, re) : undefined
        return m && { agent: f.agent, sessionId: f.sessionId, ...m, inName: true }
      }
      // Newest first across agents: a transcript file, or (no file) the agent's own store.
      const files: SearchFile[] = rows.flatMap((s) =>
        s.transcriptPath
          ? [{ agent: s.agent, sessionId: s.sessionId, file: s.transcriptPath }]
          : this.agents[s.agent]?.own
            ? [{ agent: s.agent, sessionId: s.sessionId }]
            : [],
      )
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
        name: byName,
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
