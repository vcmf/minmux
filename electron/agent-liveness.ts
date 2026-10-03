// Agent sessions that end with their process (MULTI_AGENT_IMPLEMENTATION.md §3b'). OpenCode
// sends nothing on quit, fish and pwsh no prompt mark: a session that ends that way still gets
// its SessionEnd, so it leaves the board and stops leading its pane. Pure (a clock, a liveness
// check and the platform are injected); main feeds it every batch and reaps it on a timer.

import { agentOf, type AgentEvent, type AgentKind } from "../src/lib/agent-graph"
import { pidAlive } from "./pid"

/** A dead process's last drops arrive well within this; after it, pids may be reused. */
export const LATE_MS = 10_000

interface Session {
  paneId: string
  agent: AgentKind
  cwd?: string
  transcriptPath?: string
}

export class AgentLiveness {
  private procs = new Map<number, Map<string, Session>>() // per pid: its root sessions
  private late = new Map<number, { at: number; sessions: Set<string> }>() // reaped, per pid

  constructor(
    private readonly byPid: (agent: AgentKind) => boolean, // its events carry its own pid
    private readonly alive: (pid: number) => boolean = pidAlive,
    private readonly now: () => number = Date.now,
    private readonly platform: string = process.platform,
  ) {}

  /** Note a root event's process and session, or forget a session that ended (not a late one). */
  observe(ev: AgentEvent): void {
    // Windows: WSL panes' pids are the distro's (and no by-pid agent runs there yet).
    if (this.platform === "win32" || ev.agentId || ev.pid === undefined || !ev.paneId) return
    const agent = agentOf(ev)
    if (!this.byPid(agent)) return
    // A title isn't a session at work (a background one's, or one already ended).
    if (ev.event === "SessionTitle") return
    if (ev.event === "SessionEnd") {
      const ss = this.procs.get(ev.pid)
      if (ss?.delete(ev.sessionId) && ss.size === 0) this.procs.delete(ev.pid)
      return
    }
    let ss = this.procs.get(ev.pid)
    if (!ss) this.procs.set(ev.pid, (ss = new Map()))
    const s = ss.get(ev.sessionId)
    const cwd = ev.cwd ?? s?.cwd
    const transcriptPath = ev.transcriptPath ?? s?.transcriptPath
    if (s && s.paneId === ev.paneId && s.cwd === cwd && s.transcriptPath === transcriptPath) return
    ss.set(ev.sessionId, { paneId: ev.paneId, agent, cwd, transcriptPath })
  }

  /** SessionEnds for every session of an agent process that's gone. */
  reap(): AgentEvent[] {
    const now = this.now()
    for (const [pid, l] of this.late) if (now - l.at > LATE_MS) this.late.delete(pid)
    const out: AgentEvent[] = []
    for (const [pid, ss] of this.procs) {
      if (this.alive(pid)) continue
      this.procs.delete(pid)
      this.late.set(pid, { at: now, sessions: new Set(ss.keys()) })
      for (const [sessionId, s] of ss)
        out.push({ ...s, event: "SessionEnd", sessionId, pid, reason: "exited" })
    }
    return out
  }

  /** A reaped process's drop read too late (its sessions, or a new one while the pid's still dead). */
  isLate(ev: AgentEvent): boolean {
    // Only a by-pid agent's: Claude's pid is a hook shell's (dead by the time it's read).
    if (ev.pid === undefined || !this.byPid(agentOf(ev))) return false
    const l = this.late.get(ev.pid)
    if (!l || this.now() - l.at > LATE_MS) return false
    // A new process that reused the pid is alive: its sessions count.
    return l.sessions.has(ev.sessionId) || !this.alive(ev.pid)
  }

  /** Is anything tracked (worth the periodic check)? */
  hasProcs(): boolean {
    return this.procs.size > 0
  }
}

/** The batch to fold: a dead lead's end before a new start, no late drops (and observed). */
export function foldLiveness(batch: AgentEvent[], live: AgentLiveness): AgentEvent[] {
  const kept = batch.filter((e) => !live.isLate(e))
  for (const e of kept) live.observe(e) // first: a dead process's start in this very batch too
  if (!live.hasProcs() || !kept.some((e) => e.event === "SessionStart")) return kept
  // A session starting where a dead one led: that one ends first, so the new one leads and
  // isn't nested in a dead session (the dead one's own events stay before its end).
  const ends = live.reap()
  if (ends.length === 0) return kept
  const dead = new Set(ends.map((e) => e.pid))
  const fromDead = (e: AgentEvent) => e.pid !== undefined && dead.has(e.pid)
  return [...kept.filter(fromDead), ...ends, ...kept.filter((e) => !fromDead(e))]
}
