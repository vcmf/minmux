// The connection lifecycle of an ssh pane, as pure rules (terminal-manager does the I/O).

import type { SshSettings } from "./ssh-validate"
import { hasControlChar } from "./control-chars"
import { canRetry, sshFailureKind, type SshFailure } from "./ssh-errors"
import type { SessionStatus } from "./session-status"
import { statusUi, type StatusUi } from "./status-ui"

/** Where an ssh pane's connection is. `waiting` / `closed` / `failed` wait for Enter. */
export type RemotePhase =
  | "starting" // requested, and ssh hasn't printed anything yet ("connecting")
  | "live" // ssh is running
  | "prompt" // live, and ssh (or the host) is asking for a password, code or host key
  | "waiting" // restored with restore = on-focus: nothing started yet
  | "closed" // ssh exited (a dropped link, or `exit` on the host)
  | "failed" // main couldn't start it (host gone from the config, ssh missing, …)

/** The phases that show a prompt and a Connect button instead of a live shell. */
export type RemoteIdle = Extract<RemotePhase, "waiting" | "closed" | "failed">

export const isIdle = (p: RemotePhase | undefined): p is RemoteIdle =>
  p === "waiting" || p === "closed" || p === "failed"

/** How a pane's first start asks main: a restored pane under on-focus only reattaches (a
 *  reload keeps a live ssh), anything else spawns. */
export function firstStart(restored: boolean, restore: SshSettings["restore"]): "spawn" | "attach" {
  return restored && restore === "on-focus" ? "attach" : "spawn"
}

/** The phase once main answers a start: nothing live to reattach → waiting; a reattached ssh
 *  is live; a fresh one stays "connecting" until it prints (onOutput). A later exit or error
 *  already moved it on. */
export function afterStart(
  phase: RemotePhase,
  started: boolean | undefined,
  reattached = false,
): RemotePhase {
  if (phase !== "starting") return phase
  if (started === false) return "waiting"
  return reattached ? "live" : "starting"
}

/** Output arrived: a connecting pane is now live, and a prompt that got its answer is over. */
export function onOutput(phase: RemotePhase): RemotePhase {
  return phase === "starting" || phase === "prompt" ? "live" : phase
}

/** A key typed into the pane: to the shell while it runs. In an idle pane Enter connects
 *  (unless it never can) and Esc closes it — on the second press (`escArmed`), since a first
 *  one is often vim habit right after a drop; anything else goes nowhere, never to a host that
 *  isn't there nor echoed ahead of a password prompt. */
export function onKey(
  phase: RemotePhase,
  data: string,
  failure?: SshFailure,
  escArmed = false,
): "forward" | "connect" | "arm-close" | "close" | "drop" {
  if (!isIdle(phase)) return "forward"
  if (data === "\x1b") return escArmed ? "close" : "arm-close"
  if (data === "\r") return phase === "failed" && failure && !canRetry(failure) ? "drop" : "connect"
  return "drop"
}

/** Whether the cursor line may be an auth question at all: never in a full-screen program
 *  (vim on a `password:` line), and not a line the user is typing (`if password:` in a REPL) —
 *  only when nothing was typed since, or the last thing typed ended with Enter (sudo). */
export function mayBePrompt(o: { alternateScreen: boolean; lastKey?: string }): boolean {
  if (o.alternateScreen) return false
  return o.lastKey === undefined || o.lastKey.endsWith("\r")
}

/** What ssh (or the host) is asking for, from the line the cursor sits on; null for none. */
export type AuthPrompt = "password" | "passphrase" | "code" | "PIN" | "host key"

export function authPrompt(line: string): AuthPrompt | null {
  const l = line.trimEnd()
  if (l.length > 300) return null
  if (/are you sure you want to continue connecting \(yes\/no(\/\[fingerprint\])?\)\?$/i.test(l)) {
    return "host key"
  }
  if (!/:$/.test(l)) return null
  if (/passphrase for key\b/i.test(l)) return "passphrase"
  if (/\bPIN\b/.test(l)) return "PIN"
  if (/(verification code|one[- ]time|\botp\b|authenticator|\btoken\b|\bcode\b)/i.test(l))
    return "code"
  if (/password/i.test(l)) return "password"
  return null
}

/** Why ssh exited, in words. */
export function exitReason(code: number, signal: number): string {
  if (signal) return `ssh was stopped (signal ${signal})`
  if (code === 255) return "the connection dropped or was refused"
  return `ssh exited with code ${code}`
}

/** What an idle pane says, after `[smterm]`: what happened, then the keys that act on it. */
export function idleMessage(
  phase: RemoteIdle,
  label: string,
  info?: {
    code?: number
    signal?: number
    error?: string
    wslDistro?: string
    retry?: { attempt: number; delayMs: number } // an automatic reconnect is scheduled
    gaveUp?: number // the automatic reconnects ran out after this many tries
  },
): string {
  const close = "Esc twice to close"
  if (phase === "waiting") return `${label} isn't connected yet. Enter to connect · ${close}`
  if (phase === "failed") {
    const error = cleanError(info?.error)
    switch (sshFailureKind(error)) {
      case "host-gone":
        return info?.wslDistro
          ? `${label} isn't in ${info.wslDistro}'s ssh config any more, or the distro was removed. Enter to retry · ${close}`
          : `${label} isn't in your ssh config any more. Add it back, then Enter to retry · ${close}`
      case "no-ssh":
        return `ssh isn't installed or isn't on PATH. Install OpenSSH, then Enter to retry · ${close}`
      case "not-here":
        return `${label} can't be opened here: ${error}. ${close}`
      case "wsl-down":
        return `${error}. Enter to retry · ${close}`
      default:
        return `couldn't connect to ${label}: ${error}. Enter to retry · ${close}`
    }
  }
  const code = info?.code ?? 0
  const signal = info?.signal ?? 0
  if (info?.retry) {
    const { attempt, delayMs } = info.retry
    return `Connection to ${label} lost (${exitReason(code, signal)}). Reconnecting in ${Math.round(delayMs / 1000)} s (${attempt}/${RETRY_DELAYS_MS.length}) · Enter to reconnect now · ${close}`
  }
  if (info?.gaveUp) {
    return `Couldn't reconnect to ${label} after ${info.gaveUp} ${info.gaveUp === 1 ? "try" : "tries"}. Enter to try again · ${close}`
  }
  if (code === 0 && !signal) {
    return `Session on ${label} ended. Enter to start a new one · ${close}`
  }
  return `Connection to ${label} lost (${exitReason(code, signal)}). Enter to reconnect · ${close}`
}

/** How a remote pane's state shows wherever a pane's status does (sidebar, tabs, header);
 *  a live pane shows its ordinary status. */
export function remoteStatusUi(
  phase: RemotePhase | undefined,
  status: SessionStatus,
  detail?: string, // the prompt kind (phase "prompt") or "ended" / "lost" (phase "closed")
): StatusUi {
  const prompt = detail as AuthPrompt | undefined
  switch (phase) {
    case "starting":
      return { dot: "faint", word: "connecting", pulse: true }
    case "prompt":
      return { dot: "amber", word: prompt ?? "needs input", pulse: false }
    case "closed": // `detail`: "ended" (a clean exit), "retrying" (a reconnect is scheduled), "lost"
      if (detail === "ended") return { dot: "hollow", word: "ended", pulse: false }
      if (detail === "retrying") return { dot: "amber", word: "reconnecting", pulse: true }
      return { dot: "red", word: "disconnected", pulse: false }
    case "failed":
      return { dot: "red", word: "can't connect", pulse: false }
    case "waiting":
      return { dot: "hollow", word: "not connected", pulse: false }
    default:
      return statusUi(status)
  }
}

/** A dim `[smterm] …` line on its own row, for xterm. */
export const banner = (text: string): string => `\r\n\x1b[2m[smterm] ${text}\x1b[0m\r\n`

const MAX_ERROR = 300

/** A spawn error as one safe line: Electron's invoke prefix dropped, no control chars. */
export function cleanError(e: unknown): string {
  let s = e instanceof Error ? e.message : String(e ?? "")
  s = s.replace(/^Error invoking remote method '[^']*':\s*/, "").replace(/^Error:\s*/, "")
  if (hasControlChar(s)) s = [...s].map((c) => (hasControlChar(c) ? " " : c)).join("")
  s = s.trim() || "unknown error"
  return s.length > MAX_ERROR ? `${s.slice(0, MAX_ERROR)}…` : s
}

/** A CSI that moves the cursor to the last non-blank row when it sits above it (a program left
 *  it there), so a banner written next can't overwrite output; "" when it's already below.
 *  Rows are absolute buffer lines; `baseY` is the top of the screen. */
export function cursorBelowContent(o: {
  lastContentRow: number // -1 = nothing written
  cursorRow: number
  baseY: number
}): string {
  if (o.cursorRow >= o.lastContentRow) return ""
  return `\x1b[${o.lastContentRow - o.baseY + 1};1H` // 1-based screen row; the banner's \r\n steps below
}

/** A tab's ssh summary: any pane at a prompt → "prompt"; else any lost or failed connection →
 *  "down" (a clean `exit` isn't); else null (the tab's ordinary badge applies). */
export function tabRemoteBadge(
  panes: { phase?: RemotePhase; detail?: string }[],
): "prompt" | "down" | null {
  if (panes.some((p) => p.phase === "prompt")) return "prompt"
  const down = panes.some((p) => isDown(p.phase, p.detail))
  return down ? "down" : null
}

/** Backoff for the automatic reconnects after a drop; their count is the budget. */
export const RETRY_DELAYS_MS = [2000, 5000, 10000]
/** A connection live this long counts as established: its drop starts a fresh retry budget.
 *  Shorter-lived ones (usually an auth failure) only continue a sequence already running. */
export const STABLE_MS = 30_000

/** Whether to reconnect a dropped ssh on its own, and when. Only a lost link (exit 255 and
 *  ssh saying so, no signal) of an established connection — never a clean exit, a remote
 *  command's own code, a drop at a password / host-key prompt, or something that dies at once
 *  — at most RETRY_DELAYS_MS.length times in a row and MAX_AUTO_RECONNECTS in all. Each try is
 *  a fresh login: the shell's history is gone, and a `RemoteCommand` in the config runs again. */
export function retryPlan(o: {
  enabled: boolean
  code: number
  signal: number
  atPrompt: boolean
  dropped: boolean // ssh said the link went (lostLink on its last lines), not a mere 255
  liveForMs: number // how long it was live since its last prompt (0 = never got past connecting)
  attempt: number // the retry this connection came from (0 = not a retry)
  total: number // automatic reconnects of this pane since you last connected it yourself
}): { attempt: number; delayMs: number } | null {
  if (!retryEligible(o)) return null
  if (o.total >= MAX_AUTO_RECONNECTS) return null // a link that keeps dropping: your call now
  const next = o.liveForMs >= STABLE_MS ? 1 : o.attempt > 0 ? o.attempt + 1 : 0
  if (next === 0 || next > RETRY_DELAYS_MS.length) return null
  return { attempt: next, delayMs: RETRY_DELAYS_MS[next - 1]! }
}

/** An exit that auto-reconnect may act on at all: a lost link, per ssh itself. */
export function retryEligible(o: {
  enabled: boolean
  code: number
  signal: number
  atPrompt: boolean
  dropped: boolean
}): boolean {
  return o.enabled && !o.signal && o.code === 255 && !o.atPrompt && o.dropped
}

/** At most this many automatic reconnects per pane until you reconnect it yourself. */
export const MAX_AUTO_RECONNECTS = 6

// What ssh prints when the link (not the session) went. Exit 255 alone isn't enough: ssh
// passes through the remote shell's status, and a logout after a failed command can be 255.
const LOST_LINK =
  /(closed by remote host|broken pipe|connection reset|server .* not responding|network is unreachable|connection timed out|no route to host|connection refused|could not resolve hostname)/i

/** Whether ssh's last lines say the connection was lost. */
export const lostLink = (tail: string): boolean => LOST_LINK.test(tail)

/** An ssh pane waiting to be connected: at a Connect prompt, or restored under on-focus in a
 *  tab not shown yet (not started, so no phase). */
export function isWaitingRemote(
  s: { remote?: unknown; restored?: boolean },
  phase: RemotePhase | undefined,
  restore: SshSettings["restore"],
): boolean {
  if (!s.remote) return false
  return phase === "waiting" || (phase === undefined && !!s.restored && restore === "on-focus")
}

/** The ssh panes Connect all connects. */
export function waitingRemoteIds(
  sessions: Record<string, { id: string; remote?: unknown; restored?: boolean }>,
  phases: Record<string, RemotePhase>,
  restore: SshSettings["restore"],
): string[] {
  return Object.values(sessions)
    .filter((s) => isWaitingRemote(s, phases[s.id], restore))
    .map((s) => s.id)
}

/** How many ssh panes are waiting (the Connect all count), without building the list. */
export function countWaitingRemote(
  sessions: Record<string, { id: string; remote?: unknown; restored?: boolean }>,
  phases: Record<string, RemotePhase>,
  restore: SshSettings["restore"],
): number {
  let n = 0
  for (const s of Object.values(sessions)) if (isWaitingRemote(s, phases[s.id], restore)) n++
  return n
}

/** A connection that's down and waiting on you: lost or failed (a clean exit isn't, nor one
 *  reconnecting on its own). One rule for the tab dot and the Remote header. */
export const isDown = (phase: RemotePhase | undefined, detail?: string): boolean =>
  phase === "failed" || (phase === "closed" && detail !== "ended" && detail !== "retrying")

/** The Remote header's status: ssh connections (panes) by state. */
export interface RemoteSummary {
  live: number // ssh running (incl. one at a password prompt)
  connecting: number // dialing, or reconnecting on its own: nothing for you to do
  needsYou: number // at a password / host-key prompt
  down: number // lost or failed, waiting on you
}

export function remoteSummary(
  sessions: Record<string, { id: string; remote?: unknown }>,
  phases: Record<string, RemotePhase>,
  details: Record<string, string>,
): RemoteSummary {
  const out = { live: 0, connecting: 0, needsYou: 0, down: 0 }
  for (const s of Object.values(sessions)) {
    if (!s.remote) continue
    const p = phases[s.id]
    const d = details[s.id]
    if (p === "live" || p === "prompt") out.live++
    if (p === "starting" || (p === "closed" && d === "retrying")) out.connecting++
    if (p === "prompt") out.needsYou++
    if (isDown(p, d)) out.down++
  }
  return out
}

/** The summary in words, for the header's tooltip and accessible name ("" when nothing). */
export function summaryText(s: RemoteSummary): string {
  const n = (k: number, one: string, many = `${one}s`) => `${k} ${k === 1 ? one : many}`
  return [
    s.live && n(s.live, "connection"),
    s.connecting && `${s.connecting} connecting`,
    s.needsYou && `${s.needsYou} need${s.needsYou === 1 ? "s" : ""} you`,
    s.down && `${s.down} disconnected`,
  ]
    .filter(Boolean)
    .join(" · ")
}
