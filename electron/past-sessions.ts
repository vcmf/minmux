// The Sessions tab's list (docs/design/AGENT_SESSIONS.md): every enabled agent's past sessions,
// merged newest first, each folder checked once (bounded: a hung mount never holds the list).
// The last listing stays here, so a resume uses main's own record of a session (its folder and
// transcript), never what the renderer sends back.

import type { AgentKind } from "../src/lib/agent-graph"
import { mergePast, type PastSession, type PastSessionsResult } from "../src/lib/past-sessions"
import { mapLimit } from "./history-read"
import type { ListedSession, SessionHistory } from "./agents/types"

export const STAT_MS = 1500

const key = (agent: AgentKind, sessionId: string) => `${agent}:${sessionId}`

export class PastSessions {
  private listed = new Map<string, ListedSession>()
  private running: Promise<PastSessionsResult> | null = null

  // Main checks folders in a utility worker (a dead mount never ties up main's threads).
  constructor(private readonly exists: (dir: string) => Promise<boolean | undefined>) {}

  // A call while one is running shares it: a tab switched back and forth walks the disk once.
  /** Each agent's sessions merged; an agent whose history fails is named in `failed`. */
  list(histories: { agent: AgentKind; history: SessionHistory }[]): Promise<PastSessionsResult> {
    this.running ??= this.read(histories).finally(() => (this.running = null))
    return this.running
  }

  /** A session a search found (maybe beyond the listing's first 500): resumable like a listed one. */
  remember(s: ListedSession): void {
    this.listed.set(key(s.agent, s.sessionId), s)
  }

  /** A session from the last listing (its folder and transcript, as main read them). */
  find(agent: AgentKind, sessionId: string): ListedSession | undefined {
    return this.listed.get(key(agent, sessionId))
  }

  private async read(
    histories: { agent: AgentKind; history: SessionHistory }[],
  ): Promise<PastSessionsResult> {
    const failed: AgentKind[] = []
    const lists = await Promise.all(
      histories.map(({ agent, history }) =>
        history.list().catch(() => {
          failed.push(agent)
          return [] as ListedSession[]
        }),
      ),
    )
    const merged = mergePast(lists) as ListedSession[]
    this.listed = new Map(merged.map((s) => [key(s.agent, s.sessionId), s]))
    const dirs = [...new Set(merged.flatMap((s) => (s.cwd ? [s.cwd] : [])))]
    const found = new Map<string, boolean | undefined>()
    await mapLimit(dirs, 8, async (d) => found.set(d, await this.exists(d)))
    // The renderer gets the rows without main's file paths.
    const sessions = merged.map((l): PastSession => {
      const s: ListedSession = { ...l }
      delete s.transcriptPath
      return s.cwd && found.get(s.cwd) === false ? { ...s, cwdGone: true } : s
    })
    return { sessions, failed }
  }
}
