// Which coding-agent session each terminal is inside — persisted, so a relaunch can type the
// agent's resume command (`claude --resume <id>`) back into the right pane (cmux-style). Fed by
// the hook events we already receive (SessionStart / SessionEnd carry session_id, cwd,
// transcript_path, permission_mode, and the pane id from the drop file's name). The agent's
// own rules (resume command, folder check, what counts as a switch) come from its adapter
// (electron/agents); the rules below are the ledger's.
//
// Files: Claude's entries live in `agent-sessions.json` exactly as before; every other
// agent's in `agent-sessions.<agent>.json`, which older builds never read or rewrite (so a
// downgrade can't type `claude --resume <codex-id>` nor delete them). Claude's file also
// carries a `__minmux` marker: older builds skip it on load (no session id) and drop it when
// they rewrite the file, so a Claude file WITHOUT it means an older build wrote it last and
// may have reused the panes another agent's file names — those files are then ignored (and
// rewritten). On load the newest entry wins when two files name the same pane.
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

import { hasControlChar } from "../src/lib/control-chars"
import fs from "node:fs"
import path from "node:path"
import { agentOf, type AgentEvent, type AgentKind } from "../src/lib/agent-graph"
import type { ResumePlan } from "../src/lib/resume"
import { AGENT_RULES } from "./agents"
import type { SessionRules } from "./agents/types"

export interface LedgerEntry {
  agent?: AgentKind // absent ⇒ "claude" (the file says which agent; never persisted)
  sessionId: string // the agent's session id (→ e.g. `claude --resume <id>`)
  cwd: string // where the agent ran — Claude's transcripts are keyed by this project dir
  transcriptPath?: string
  permissionMode?: string
  name?: string // /rename, for the banner
  wslDistro?: string // the pane's distro (WSL) — its transcript lives on that distro's share
  pid?: number // the agent process leading the pane (this run only, never persisted)
  updatedAt: number
  carried?: boolean // loaded from disk = the PREVIOUS run's (in memory only, never persisted)
}

// Key of the marker this build writes into Claude's file (see the header).
const MARKER = "__minmux"

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
  private readonly files: [AgentKind, string][] // each agent's ledger file

  constructor(
    file: string | null, // Claude's file (`agent-sessions.json`); null = in-memory (tests)
    private readonly now: () => number = Date.now,
    private readonly rules: Partial<Record<AgentKind, SessionRules>> = AGENT_RULES,
  ) {
    const kinds = Object.keys(rules) as AgentKind[]
    this.files = !file
      ? []
      : kinds.map((k) => [k, k === "claude" ? file : file.replace(/(\.json)?$/, `.${k}.json`)])
    const read = (f: string): Record<string, LedgerEntry> | null => {
      try {
        const raw: unknown = JSON.parse(fs.readFileSync(f, "utf8"))
        return raw && typeof raw === "object" ? (raw as Record<string, LedgerEntry>) : {}
      } catch {
        return null // no ledger yet / unreadable
      }
    }
    const claudeFile = file ? read(file) : null
    // An older build wrote Claude's file last: the other agents' files may be stale.
    const olderBuildRan = claudeFile !== null && !(MARKER in claudeFile)
    for (const [kind, f] of this.files) {
      if (kind !== "claude" && olderBuildRan) continue
      const raw = kind === "claude" ? claudeFile : read(f)
      if (raw) this.load(kind, raw)
    }
  }

  private load(kind: AgentKind, raw: Record<string, LedgerEntry>): void {
    for (const [pane, e] of Object.entries(raw)) {
      if (e && typeof e.sessionId === "string" && typeof e.cwd === "string") {
        const updatedAt = typeof e.updatedAt === "number" ? e.updatedAt : 0
        const prev = this.entries.get(pane)
        if (prev && prev.updatedAt >= updatedAt) continue // two files name the pane: newest wins
        // Hand-edited / corrupted files: keep only well-typed fields (a non-string name would
        // reach the banner's render).
        const str = (v: unknown) => (typeof v === "string" ? v : undefined)
        this.entries.set(pane, {
          agent: kind,
          sessionId: e.sessionId,
          cwd: e.cwd,
          transcriptPath: str(e.transcriptPath),
          permissionMode: str(e.permissionMode),
          name: str(e.name),
          wslDistro: str(e.wslDistro),
          updatedAt,
          carried: true,
        })
      }
    }
  }

  /** Fold one hook event. For a SessionStart: whether its folder was replaced (`fallback`, with
   *  the folder used) or it was dropped (`rejected`) — main rewrites the event to match. */
  apply(ev: AgentEvent, wslDistro?: string): { verdict?: "rejected" | "fallback"; cwd?: string } {
    if (this.frozen || !ev.paneId || ev.agentId) return {}
    const agent = agentOf(ev)
    const rules = this.rules[agent]
    if (!rules) return {} // an agent without resume rules is never recorded
    const pane = ev.paneId
    const cur = this.entries.get(pane)
    if (ev.event === "SessionEnd") {
      this.nested.get(pane)?.delete(ev.sessionId) // a closed pane's late end adds no entry back
      if (cur?.sessionId === ev.sessionId) this.delete(pane)
      return {}
    }
    // A session once launched inside the pane's lead stays nested until it ends — a background
    // agent keeps running after the lead exits (or across a thaw) and must never become it.
    const nested = this.nestedIn(pane)
    if (nested.has(ev.sessionId)) return {}
    if (ev.event === "SessionStart") {
      if (!ev.cwd) return {}
      // Another session starting while the pane's session (recorded THIS run) is live was
      // launched from inside it — a background agent (its startup, compact or resume), a nested
      // `claude -p`, another agent run by it. A real switch ends the old one first; what the
      // agent counts as a switch even if that SessionEnd got lost (Claude: /clear, a fork) only
      // applies to its own sessions. A carried-over entry is always replaceable.
      const isSwitch = !!cur && agentOf(cur) === agent && rules.isSwitch(ev, cur)
      // Folders verified under another agent's rules say nothing about this one's sessions.
      if (cur && agentOf(cur) !== agent) this.verified.delete(pane)
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
      const fits = rules.cwdFits(cwd, ev.transcriptPath)
      if (fits === false) {
        const known = [this.verified.get(pane), cur?.cwd].find(
          (k) => k !== undefined && rules.cwdFits(k, ev.transcriptPath) === true,
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
        agent,
        sessionId: ev.sessionId,
        cwd,
        // The same session restarting keeps what the event doesn't say (a stray event carries
        // no permission mode — it mustn't drop the session's `auto`).
        transcriptPath: ev.transcriptPath ?? (same ? cur.transcriptPath : undefined),
        permissionMode: ev.permissionMode ?? (same ? cur.permissionMode : undefined),
        name: same ? cur.name : undefined,
        wslDistro,
        pid: ev.pid,
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
    if (ev.cwd && ev.cwd !== cur.cwd && rules.cwdFits(ev.cwd, ev.transcriptPath) === true) {
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
        const rules = this.rules[agentOf(e)]
        const command = rules?.resumeCommand(e, allowBypass) ?? null
        const env = rules?.resumeEnv?.(e)
        const base = {
          agent: agentOf(e),
          cwd: e.cwd,
          name: e.name,
          sessionId: e.sessionId,
          ...(env ? { env } : {}),
        }
        if (!rules || !command) {
          out[id] = { ...base, status: "skip", reason: "unrecognised session id" }
          return
        }
        // The cwd may be TYPED into a line editor (`cd -- '…'`): control characters there act
        // as editing keys (^C aborts, CR submits) and could break out of the quoting.
        if (hasControlChar(e.cwd)) {
          out[id] = { ...base, status: "skip", reason: "its folder name can't be typed safely" }
          return
        }
        // A folder that isn't where the agent filed the session (Claude: `claude --resume`
        // can't find it there; older entries recorded before this check).
        if (rules.cwdFits(e.cwd, e.transcriptPath) === false) {
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
    if (this.files.length === 0) return
    clearTimeout(this.timer)
    this.timer = setTimeout(() => void this.flushAsync(), 500)
  }

  /** One agent's entries as its file's JSON (no `agent` field: the file says which). */
  private serialize(kind: AgentKind): string {
    const out: Record<string, unknown> = {}
    for (const [id, e] of this.entries) {
      const { carried, agent, pid, ...persisted } = e
      void carried // in-memory only
      void pid // per run: meaningless after a relaunch
      if (agentOf({ agent }) === kind) out[id] = persisted
    }
    if (kind === "claude") out[MARKER] = { v: 1 } // "written by a multi-agent build"
    return JSON.stringify(out, null, 2)
  }

  // temp + rename: a crash / power loss mid-write can't leave truncated JSON (which would
  // lose every entry — the very case this file exists for). Every file is rewritten, so a
  // pane whose lead changed agent leaves the old file in the same flush; each file on its
  // own, so one that can't be written never blocks another agent's.
  private async flushAsync(): Promise<void> {
    if (this.files.length === 0 || this.frozen) return // a freeze wrote synchronously
    const v = this.version
    const writes = this.files.map(([kind, file]) => ({ file, tmp: `${file}.${v}.tmp`, kind }))
    try {
      await fs.promises.mkdir(path.dirname(this.files[0]![1]), { recursive: true })
    } catch {
      return // best-effort — a missed write only means no resume for those sessions
    }
    const ok = await Promise.all(
      writes.map((w) =>
        fs.promises.writeFile(w.tmp, this.serialize(w.kind)).then(
          () => true,
          () => false,
        ),
      ),
    )
    const current = v === this.version && !this.frozen
    await Promise.all(
      writes.map((w, i) =>
        (current && ok[i] ? fs.promises.rename(w.tmp, w.file) : Promise.reject()).catch(() =>
          fs.promises.rm(w.tmp, { force: true }).catch(() => {}),
        ),
      ),
    )
    if (current && this.frozen) this.flushSync() // a freeze raced the renames: rewrite it
  }

  /** Synchronous write — only on quit / shutdown, when the process may die right after. */
  flushSync(): void {
    clearTimeout(this.timer)
    for (const [kind, file] of this.files) {
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true })
        const tmp = `${file}.tmp`
        fs.writeFileSync(tmp, this.serialize(kind))
        fs.renameSync(tmp, file)
      } catch {
        // best-effort
      }
    }
  }
}
