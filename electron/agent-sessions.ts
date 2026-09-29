// Which Claude Code session each terminal is inside — persisted, so a relaunch can type
// `claude --resume <id>` back into the right pane (cmux-style). Fed by the hook events we
// already receive (SessionStart / SessionEnd carry session_id, cwd, transcript_path,
// permission_mode, and the pane id from the drop file's name).
//
// Rules (see docs/GOTCHAS.md#resume):
//   - SessionStart sets the pane's entry when there is none, or when it continues the same
//     conversation line (/clear, /compact, resume, fork). A fresh `startup` while an entry is
//     live is a NESTED claude (e.g. `claude -p` run by the agent's Bash tool, which inherits
//     the pane id) — ignored, so it can't overwrite (or, via its SessionEnd, delete) the parent.
//   - Later events refresh the permission mode (Shift-Tab changes it mid-session).
//   - ANY SessionEnd of the tracked session while minmux runs clears it (/exit, double Ctrl-C
//     — which may report "other" — logout), and so does the shell's prompt returning
//     (`shellIdle`: the foreground program exited — covers a Claude killed without a
//     SessionEnd). Only a quit/shutdown (freeze) or an app crash leaves entries to resume.
//   - Closing the pane / the shell exiting drops it (unless frozen).

import { cwdMatchesTranscript } from "../src/lib/claude-project"
import { hasControlChar } from "../src/lib/control-chars"
import fs from "node:fs"
import path from "node:path"
import type { AgentEvent } from "../src/lib/agent-graph"
import type { ResumePlan } from "../src/lib/resume"

export interface LedgerEntry {
  sessionId: string // Claude's session id (→ `claude --resume <id>`)
  cwd: string // where Claude ran — its transcripts are keyed by this project dir
  transcriptPath?: string
  permissionMode?: string
  name?: string // /rename, for the banner
  wslDistro?: string // the pane's distro (WSL) — its transcript lives on that distro's share
  updatedAt: number
  carried?: boolean // loaded from disk = the PREVIOUS run's (in memory only, never persisted)
}

// Claude session ids are UUIDs; permission modes are single words. Anything else never
// reaches a command line we type into a shell.
const SAFE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const SAFE_MODE = /^[A-Za-z]{1,32}$/

/** The resume command for an entry (null if its id can't be trusted). */
export function resumeCommand(e: LedgerEntry, allowBypass: boolean): string | null {
  if (!SAFE_ID.test(e.sessionId)) return null
  const mode = e.permissionMode
  const keepMode =
    mode &&
    SAFE_MODE.test(mode) &&
    mode !== "default" &&
    (mode !== "bypassPermissions" || allowBypass)
  return `claude --resume ${e.sessionId}${keepMode ? ` --permission-mode ${mode}` : ""}`
}

export class SessionLedger {
  // Per pane: the last folder that matched its session's transcript (in memory only).
  private verified = new Map<string, string>()
  // Per pane: sessions launched inside its lead, until they end (in memory only).
  private nested = new Map<string, Set<string>>()
  private entries = new Map<string, LedgerEntry>() // key: minmux pane (session) id
  private frozen = false
  private timer?: ReturnType<typeof setTimeout>
  private thawTimer?: ReturnType<typeof setTimeout>
  private version = 0 // bumped per change: a slow async write never lands over a newer state

  constructor(
    private readonly file: string | null, // null = in-memory (tests)
    private readonly now: () => number = Date.now,
  ) {
    if (!file) return
    try {
      const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, LedgerEntry>
      for (const [pane, e] of Object.entries(raw ?? {})) {
        if (e && typeof e.sessionId === "string" && typeof e.cwd === "string") {
          // Hand-edited / corrupted files: keep only well-typed fields (a non-string name would
          // reach the banner's render).
          const str = (v: unknown) => (typeof v === "string" ? v : undefined)
          this.entries.set(pane, {
            sessionId: e.sessionId,
            cwd: e.cwd,
            transcriptPath: str(e.transcriptPath),
            permissionMode: str(e.permissionMode),
            name: str(e.name),
            wslDistro: str(e.wslDistro),
            updatedAt: typeof e.updatedAt === "number" ? e.updatedAt : 0,
            carried: true,
          })
        }
      }
    } catch {
      // no ledger yet / unreadable — start empty
    }
  }

  /** Fold one hook event. For a SessionStart: whether its folder was replaced (`fallback`, with
   *  the folder used) or it was dropped (`rejected`) — main rewrites the event to match. */
  apply(ev: AgentEvent, wslDistro?: string): { verdict?: "rejected" | "fallback"; cwd?: string } {
    if (this.frozen || !ev.paneId || ev.agentId) return {}
    const pane = ev.paneId
    const cur = this.entries.get(pane)
    const nested = this.nestedIn(pane)
    if (ev.event === "SessionEnd") {
      nested.delete(ev.sessionId)
      if (cur?.sessionId === ev.sessionId) this.delete(pane)
      return {}
    }
    // A session once launched inside the pane's lead stays nested until it ends — a background
    // agent keeps running after the lead exits (or across a thaw) and must never become it.
    if (nested.has(ev.sessionId)) return {}
    if (ev.event === "SessionStart") {
      if (!ev.cwd) return {}
      // Another session starting while the pane's session (recorded THIS run) is live was
      // launched from inside it — a background agent (its startup, compact or resume), a nested
      // `claude -p`. A real switch ends the old one first; /clear and fork count as a switch
      // even if that SessionEnd got lost. A carried-over entry is always replaceable.
      const isSwitch = ev.source === "clear" || ev.source === "fork"
      if (cur && !cur.carried && cur.sessionId !== ev.sessionId && !isSwitch) {
        nested.add(ev.sessionId)
        return {}
      }
      // Resume must `cd` where Claude filed the session. A folder that doesn't encode to the
      // transcript's project dir — a stray event from an agent's scratchpad, or Claude sitting
      // in a subfolder when /clear starts a new session — falls back to a known folder of the
      // pane that fits; with none, it's recorded but never resumed ("rejected"). Undecided (very
      // long path, no transcript): the same session keeps its recorded folder.
      const same = cur?.sessionId === ev.sessionId
      let cwd = ev.cwd
      let verdict: "fallback" | undefined
      let rejected = false
      const fits = cwdMatchesTranscript(cwd, ev.transcriptPath)
      if (fits === false) {
        const known = [this.verified.get(pane), cur?.cwd].find(
          (k) => k !== undefined && cwdMatchesTranscript(k, ev.transcriptPath) === true,
        )
        if (known) {
          cwd = known
          verdict = "fallback"
        } else {
          // Nothing verified fits. The same session keeps its recorded folder; a new one is
          // still recorded — who leads the pane matters (else its first background agent
          // would take over) — and plan() won't resume a mismatch.
          rejected = true
          if (same) cwd = cur.cwd
        }
      } else if (fits === undefined && same) {
        cwd = cur.cwd
      }
      if (fits === true || verdict) this.verified.set(pane, cwd)
      this.set(pane, {
        sessionId: ev.sessionId,
        cwd,
        // The same session restarting keeps what the event doesn't say (a stray event carries
        // no permission mode — it mustn't drop the session's `auto`).
        transcriptPath: ev.transcriptPath ?? (same ? cur.transcriptPath : undefined),
        permissionMode: ev.permissionMode ?? (same ? cur.permissionMode : undefined),
        name: same ? cur.name : undefined,
        wslDistro,
        updatedAt: this.now(),
      })
      if (rejected) return { verdict: "rejected" }
      return verdict ? { verdict, cwd } : {}
    }
    if (cur?.sessionId !== ev.sessionId) return {}
    let next = cur
    if (ev.permissionMode && ev.permissionMode !== cur.permissionMode)
      next = { ...next, permissionMode: ev.permissionMode }
    // Claude re-files a session that enters a worktree under the worktree's folder: follow it
    // (only a folder matching the transcript's — a plain `cd src` never does).
    if (ev.cwd && ev.cwd !== cur.cwd && cwdMatchesTranscript(ev.cwd, ev.transcriptPath) === true) {
      next = { ...next, cwd: ev.cwd, transcriptPath: ev.transcriptPath }
      this.verified.set(pane, ev.cwd)
    }
    if (next !== cur) this.set(pane, { ...next, updatedAt: this.now() })
    return {}
  }

  /** Is this event's session one launched inside the pane's lead (a background agent…)? */
  isNested(paneId: string, sessionId: string): boolean {
    const lead = this.entries.get(paneId)?.sessionId
    return !!this.nested.get(paneId)?.has(sessionId) || (!!lead && lead !== sessionId)
  }

  private nestedIn(paneId: string): Set<string> {
    let set = this.nested.get(paneId)
    if (!set) this.nested.set(paneId, (set = new Set()))
    return set
  }

  /** The session's /rename (from the transcript meta tracker), shown on the resume banner. */
  setName(paneId: string, name: string | undefined): void {
    const cur = this.entries.get(paneId)
    if (cur && !this.frozen && cur.name !== name) this.set(paneId, { ...cur, name })
  }

  /** The shell prompt returned after a command: the foreground program (Claude) exited. */
  shellIdle(paneId: string): void {
    // Only the lead's entry: its background agents may still be running (they stay nested).
    if (!this.frozen && this.entries.has(paneId)) this.delete(paneId)
  }

  /** The pane closed / its shell exited — nothing to resume there any more. */
  drop(paneId: string): void {
    if (this.frozen) return
    this.verified.delete(paneId)
    this.nested.delete(paneId)
    if (this.entries.has(paneId)) this.delete(paneId)
  }

  /** Quit / OS shutdown: keep every entry and flush now; an OS-shutdown freeze thaws later. */
  freeze(thawAfterMs?: number): void {
    this.frozen = true
    this.flushSync()
    clearTimeout(this.thawTimer)
    if (thawAfterMs) {
      this.thawTimer = setTimeout(() => {
        // Shutdown cancelled. Ends/exits during the freeze were ignored, so entries may be
        // stale: make them replaceable (as if carried over) instead of blocking new sessions.
        for (const [id, e] of this.entries) this.entries.set(id, { ...e, carried: true })
        this.frozen = false
      }, thawAfterMs)
    }
  }

  /** What to resume in restored terminals (live PTYs skipped; preflight per entry). */
  async plan(
    paneIds: string[],
    isLive: (paneId: string) => boolean,
    preflight: (e: LedgerEntry) => Promise<{ skip?: string; unverified?: boolean }>,
    allowBypass: boolean,
  ): Promise<Record<string, ResumePlan>> {
    const out: Record<string, ResumePlan> = {}
    await Promise.all(
      paneIds.map(async (id) => {
        const e = this.entries.get(id)
        if (!e || isLive(id)) return
        const command = resumeCommand(e, allowBypass)
        const base = { cwd: e.cwd, name: e.name, sessionId: e.sessionId }
        if (!command) {
          out[id] = { ...base, status: "skip", reason: "unrecognised session id" }
          return
        }
        // The cwd may be TYPED into a line editor (`cd -- '…'`): control characters there act
        // as editing keys (^C aborts, CR submits) and could break out of the quoting.
        if (hasControlChar(e.cwd)) {
          out[id] = { ...base, status: "skip", reason: "its folder name can't be typed safely" }
          return
        }
        // A folder that isn't where Claude filed the session: `claude --resume` can't find it
        // there (older entries recorded before this check).
        if (cwdMatchesTranscript(e.cwd, e.transcriptPath) === false) {
          out[id] = { ...base, status: "skip", reason: "its folder doesn't match the session" }
          return
        }
        const pf = await preflight(e)
        out[id] = pf.skip
          ? { ...base, status: "skip", reason: pf.skip, command }
          : {
              ...base,
              status: "resume",
              command,
              ...(pf.unverified ? { cwdUnverified: true } : {}),
            }
      }),
    )
    return out
  }

  /** Failed/dismissed → forget the exact carried-over entry (one shot; a live one stays). */
  consume(paneId: string, sessionId: string): void {
    const e = this.entries.get(paneId)
    if (e?.carried && e.sessionId === sessionId) this.delete(paneId)
  }

  /** Drop entries for panes no longer in the workspace (closed while minmux wasn't running). */
  prune(keep: Set<string>): void {
    for (const id of [...this.entries.keys()]) if (!keep.has(id)) this.delete(id)
    for (const id of [...this.verified.keys()]) if (!keep.has(id)) this.verified.delete(id)
    for (const id of [...this.nested.keys()]) if (!keep.has(id)) this.nested.delete(id)
  }

  get(paneId: string): LedgerEntry | undefined {
    return this.entries.get(paneId)
  }

  private set(paneId: string, e: LedgerEntry) {
    this.entries.set(paneId, { ...e, carried: false })
    this.schedule()
  }

  private delete(paneId: string) {
    this.entries.delete(paneId)
    this.schedule()
  }

  // Write-through (debounced, async — never blocks the main process that carries PTY
  // output): a crash must still leave the live sessions on disk.
  private schedule() {
    this.version++
    if (!this.file) return
    clearTimeout(this.timer)
    this.timer = setTimeout(() => void this.flushAsync(), 500)
  }

  private serialize(): string {
    const out: Record<string, Omit<LedgerEntry, "carried">> = {}
    for (const [id, e] of this.entries) {
      const { carried, ...persisted } = e
      void carried // in-memory only
      out[id] = persisted
    }
    return JSON.stringify(out, null, 2)
  }

  // temp + rename: a crash / power loss mid-write can't leave truncated JSON (which would
  // lose every entry — the very case this file exists for).
  private async flushAsync(): Promise<void> {
    if (!this.file || this.frozen) return // a freeze wrote synchronously; don't race it
    const v = this.version
    const tmp = `${this.file}.${v}.tmp`
    try {
      await fs.promises.mkdir(path.dirname(this.file), { recursive: true })
      await fs.promises.writeFile(tmp, this.serialize())
      if (v === this.version && !this.frozen) {
        await fs.promises.rename(tmp, this.file)
        if (this.frozen) this.flushSync() // a freeze raced this rename: rewrite its final state
      } else await fs.promises.rm(tmp, { force: true })
    } catch {
      // best-effort — a missed write only means no resume for that session
    }
  }

  /** Synchronous write — only on quit / shutdown, when the process may die right after. */
  flushSync(): void {
    clearTimeout(this.timer)
    if (!this.file) return
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      const tmp = `${this.file}.tmp`
      fs.writeFileSync(tmp, this.serialize())
      fs.renameSync(tmp, this.file)
    } catch {
      // best-effort
    }
  }
}
