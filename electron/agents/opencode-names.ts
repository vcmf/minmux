// OpenCode's session names (MULTI_AGENT.md F12, D3). The plugin pushes each title; no flag says
// who set it, but OpenCode only ever titles a session still on its placeholder, after its first
// prompt (S2-f). So a change from the placeholder after a prompt is OpenCode's; from the
// placeholder before any prompt, or from one real title to another, it's the user's
// `/rename`. Only a user's name colours the pane. Known limit: while a prompted session is still
// on the placeholder (OpenCode's title hasn't come yet, or never will: an aborted first turn, no
// title model), a `/rename` reads as OpenCode's; the next one reads as the user's.

import type { AgentEvent } from "../../src/lib/agent-graph"
import type { MetaReader } from "../agent-meta"
import type { SessionMeta } from "../transcript-meta"

/** OpenCode's placeholder for a session not named yet: "New session - <ISO time>". */
export const isDefaultTitle = (t: string) => /^New session - \d{4}-\d{2}-\d{2}T/.test(t)

interface Named {
  title?: string // its name; undefined: none known (or still the placeholder)
  placeholder: boolean // known to be on OpenCode's placeholder now
  prompted: boolean // a turn ran since then
  user: boolean // the current title is the user's
}

const MAX_SESSIONS = 512

/** Every OpenCode session's name this run (kept after it ends: it may be resumed). */
export class OpencodeNames {
  private named = new Map<string, Named>()

  constructor(
    // Was this session's name the user's, as recorded before (a session from an earlier run)?
    private readonly userNamedBefore: (sessionId: string) => boolean | undefined = () => undefined,
    // Keep whose name it is now (per session, across runs).
    private readonly record: (sessionId: string, user: boolean) => void = () => {},
  ) {}

  /** Fold one root event of an OpenCode session. */
  apply(ev: AgentEvent): void {
    if (ev.agentId) return
    if (ev.event === "UserPromptSubmit") return void (this.get(ev.sessionId).prompted = true)
    if (ev.event !== "SessionTitle" || !ev.title) return
    const s = this.get(ev.sessionId)
    // Known to be on the placeholder only by seeing it (a fork or an imported session is
    // created with a real title). Seen again (a reloaded plugin re-sends it): a prompt counts.
    if (isDefaultTitle(ev.title)) {
      if (s.title === undefined) s.placeholder = true
      return
    }
    if (ev.title === s.title) return
    if (s.placeholder)
      s.user = !s.prompted // OpenCode titles only after a prompt
    else if (s.title !== undefined)
      s.user = true // OpenCode never retitles a named session
    else s.user = this.userNamedBefore(ev.sessionId) ?? false // first sight: as it was
    s.title = ev.title
    s.placeholder = false
    this.record(ev.sessionId, s.user)
  }

  /** The session's name for the pane: always shown; `auto` (no colour) unless the user's. */
  meta(sessionId: string): SessionMeta {
    const s = this.named.get(sessionId)
    return s?.title ? { name: s.title, auto: !s.user || undefined } : {}
  }

  // Least recently used goes first.
  private get(sessionId: string): Named {
    let s = this.named.get(sessionId)
    if (s) this.named.delete(sessionId)
    else {
      if (this.named.size >= MAX_SESSIONS) this.named.delete(this.named.keys().next().value!)
      s = { placeholder: false, prompted: false, user: false }
    }
    this.named.set(sessionId, s)
    return s
  }
}

/** The meta tracker's view of OpenCode's names: nothing to read from disk, just the store. */
export const namesReader = (names: OpencodeNames): MetaReader => ({
  update: async (_key, _candidates, sessionId) => (sessionId ? names.meta(sessionId) : {}),
  forget: () => {},
})
