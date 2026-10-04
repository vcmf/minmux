// The coding agents running in each pane, by their own process, so closing the pane (or quitting)
// makes sure they end. A hang-up reaches the shell and the kernel passes it on, but an agent that
// ignores it (OpenCode stuck in a busy loop ignores everything but SIGKILL) would outlive minmux,
// re-parented to init. Only agents whose drops carry their own pid (`liveByPid`: Codex, OpenCode)
// are known here; anything else in a terminal is left to the hang-up, as in any terminal.
// POSIX only: on Windows the pids are WSL's.

import { execFile } from "node:child_process"
import fs from "node:fs"
import { pidAlive } from "./pid"

const MAX_PER_PANE = 8 // a pane runs one agent at a time; a few restarts at most stay listed

export class AgentProcs {
  private byPane = new Map<string, number[]>()

  constructor(private readonly alive: (pid: number) => boolean) {}

  /** An agent process reported from this pane (any drop it wrote). */
  note(paneId: string, pid: number): void {
    const pids = this.byPane.get(paneId) ?? []
    // A drop read after its writer ended names a pid that may be reused: never listed.
    if (pids.includes(pid) || !this.alive(pid)) return
    // A new process: the ones that ended are dropped first (their pids may be reused later).
    const kept = pids.filter((p) => this.alive(p))
    kept.push(pid)
    this.byPane.set(paneId, kept.slice(-MAX_PER_PANE))
  }

  pidsOf(paneId: string): number[] {
    return this.byPane.get(paneId) ?? []
  }

  forget(paneId: string): void {
    this.byPane.delete(paneId)
  }
}

/** Where an agent process runs: its terminal, and its group when that's the foreground job. */
export interface ProcInfo {
  tty: string // `/dev/…`
  foreground?: number // the terminal's foreground group it's in (none: a background `… &` job)
}

export interface Procs {
  /** Each pid still running on a terminal; a failed lookup rejects. */
  info(pids: number[]): Promise<Map<number, ProcInfo>>
  alive(pid: number): boolean
  kill(pid: number, pgid?: number): void // SIGKILL, with that group too; best-effort
}

/** `ps -o pid=,pgid=,tpgid=,tty=` lines → pid → where it runs (none on a terminal: skipped). */
export function parseProcs(out: string): Map<number, ProcInfo> {
  const procs = new Map<number, ProcInfo>()
  for (const line of out.split("\n")) {
    const [pid, pgid, tpgid, tty] = line.trim().split(/\s+/)
    const n = Number(pid)
    if (!Number.isInteger(n) || n <= 1 || !tty || tty.startsWith("?")) continue
    const g = Number(pgid)
    procs.set(n, { tty: `/dev/${tty}`, ...(g > 1 && g === Number(tpgid) ? { foreground: g } : {}) })
  }
  return procs
}

// Off the hot path, and what decides whether a stuck agent dies: room for a loaded machine
// (the agent may be spinning a core). The system's ps, never a shim from the login PATH.
const PS_TIMEOUT_MS = 2000
const PS = ["/bin/ps", "/usr/bin/ps"].find((p) => fs.existsSync(p)) ?? "ps"

export const posixProcs: Procs = {
  info: (pids) =>
    new Promise((resolve, reject) => {
      if (!pids.length) return resolve(new Map())
      execFile(
        PS,
        ["-o", "pid=,pgid=,tpgid=,tty=", "-p", pids.join(",")],
        { timeout: PS_TIMEOUT_MS },
        (err, out, stderr) => {
          // ps exits 1, silently, when one of the pids is gone: what it printed still counts
          if (err && (err.killed || typeof err.code !== "number" || stderr.trim())) reject(err)
          else resolve(parseProcs(out ?? ""))
        },
      )
    }),
  alive: pidAlive,
  kill: (pid, pgid) => {
    for (const target of pgid ? [-pgid, pid] : [pid])
      try {
        process.kill(target, "SIGKILL")
      } catch {
        // gone already
      }
  },
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
export const noop = () => {}

/** Give agents `graceMs` after the hang-up, then SIGKILL each left with its foreground job. */
export async function endProcs(
  agents: { pid: number; pgid?: number }[],
  procs: Procs,
  { graceMs = 1500, pollMs = 50 }: { graceMs?: number; pollMs?: number } = {},
): Promise<number[]> {
  let left = agents.filter((a) => procs.alive(a.pid))
  for (let waited = 0; left.length && waited < graceMs; waited += pollMs) {
    await sleep(pollMs)
    left = left.filter((a) => procs.alive(a.pid))
  }
  for (const a of left) procs.kill(a.pid, a.pgid)
  return left.map((a) => a.pid) // the ones that had to be killed
}
