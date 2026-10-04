// Quit without racing node-pty: its exit callback runs on a background thread and calls back
// into JS; if that lands while Electron is tearing Node down, node-pty throws a C++ exception
// nobody catches → abort() (SIGABRT crash report on ⌘Q). So quitting waits for every PTY's
// exit first — bounded, so a stuck child can never block the quit. A coding agent running in one
// is made to end too: one that ignores the hang-up would outlive minmux (agent-procs.ts).

import { endProcs, noop, sleep, type Procs } from "./agent-procs"

/** What draining needs from a PTY: a way to signal it and a promise of its exit. */
export interface Drainable {
  kill: (signal?: string) => void
  exited: Promise<void>
  killed?: boolean // already hung up (a closed pane winding down): wait, don't re-signal
  tty?: string // its terminal (`/dev/…`): an agent pid still on it is still that agent
  agentPids?: () => number[] // the agents known to run in it (their own pids)
}

export interface DrainOptions {
  graceMs?: number // wait after the hang-up before forcing
  forceMs?: number // wait after SIGKILL
  signals?: boolean // false on Windows: no signals (a queued SIGKILL would throw later)
  settleMs?: number // extra wait after the exits (Windows: ConPTY's native callback trails 'exit')
  procs?: Procs // the terminals' agents: SIGKILLed if still running after the grace
  onAgentsKilled?: (pids: number[]) => void
  onLookupFailed?: (err: unknown) => void // no ps: the agents are left to the hang-up
}

/** Resolves true if every exit settled within `ms`, else false (never rejects). */
function allWithin(ps: Promise<void>[], ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<boolean>((res) => (timer = setTimeout(() => res(false), ms)))
  return Promise.race([Promise.all(ps).then(() => true), timeout]).finally(() =>
    clearTimeout(timer),
  )
}

/** Hang up every PTY, wait for the exits, SIGKILL stragglers; always resolves (true = clean). */
export async function drainPtys(
  ptys: Drainable[],
  {
    graceMs = 1500,
    forceMs = 500,
    signals = true,
    settleMs = 0,
    procs,
    onAgentsKilled,
    onLookupFailed,
  }: DrainOptions = {},
): Promise<boolean> {
  if (ptys.length === 0) return true
  const alive = new Set(ptys)
  for (const p of ptys) void p.exited.then(() => alive.delete(p))
  const toHangUp = ptys.filter((p) => !p.killed)
  const hangUp = (p: Drainable) => {
    p.killed = true // a later drain (a quit) waits for it without signalling again
    try {
      p.kill() // SIGHUP: the shell (and a Claude inside it) shuts down normally
    } catch {
      // Already gone, or a half-closed handle: keep waiting on its exit all the same — a
      // failed kill doesn't prove its exit callback has run.
    }
  }
  // The agents known to run in them (still alive: an ended one's pid may be reused)…
  const agents = toHangUp.flatMap((p) =>
    procs && p.tty
      ? (p.agentPids?.() ?? []).filter((pid) => procs.alive(pid)).map((pid) => ({ pid, p }))
      : [],
  )
  // …so the others hang up at once, and these after one ps (for all) that keeps the agents still
  // in their terminal's foreground job: a pid since reused elsewhere is never touched, and neither
  // is a job the user sent to the background (`nohup … &`), which outlives a terminal anywhere.
  const withAgents = new Set(agents.map((a) => a.p))
  for (const p of toHangUp) if (!withAgents.has(p)) hangUp(p)
  const info = agents.length
    ? await procs!.info(agents.map((a) => a.pid)).catch((err: unknown) => {
        onLookupFailed?.(err)
        return null
      })
    : null
  const ours = agents.flatMap(({ pid, p }) => {
    const at = info?.get(pid)
    return at && at.tty === p.tty && at.foreground ? [{ pid, pgid: at.foreground }] : []
  })
  for (const p of withAgents) if (!p.killed) hangUp(p)
  // In parallel with the shells, on the same grace: an agent ending with its shell costs nothing.
  const agentsEnded = ours.length
    ? endProcs(ours, procs!, { graceMs })
        .then((killed) => {
          if (killed.length) onAgentsKilled?.(killed)
        })
        .catch(noop) // a failing callback mustn't fail the drain
    : Promise.resolve()
  let clean = await allWithin(
    [...alive].map((p) => p.exited),
    graceMs,
  )
  if (!clean && signals) {
    for (const p of alive) {
      try {
        p.kill("SIGKILL")
      } catch {
        // already gone
      }
    }
    clean = await allWithin(
      [...alive].map((p) => p.exited),
      forceMs,
    )
  }
  await agentsEnded
  if (settleMs) await sleep(settleMs)
  return clean
}
