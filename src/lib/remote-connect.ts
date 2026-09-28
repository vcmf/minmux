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
 *  (unless it never can), Esc closes it, and anything else goes nowhere — never to a host that
 *  isn't there, nor echoed ahead of a password prompt. */
export function onKey(
  phase: RemotePhase,
  data: string,
  failure?: SshFailure,
): "forward" | "connect" | "close" | "drop" {
  if (!isIdle(phase)) return "forward"
  if (data === "\x1b") return "close"
  if (data === "\r") return phase === "failed" && failure && !canRetry(failure) ? "drop" : "connect"
  return "drop"
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
  info?: { code?: number; signal?: number; error?: string },
): string {
  const close = "Esc to close"
  if (phase === "waiting") return `${label} isn't connected yet. Enter to connect · ${close}`
  if (phase === "failed") {
    const error = cleanError(info?.error)
    switch (sshFailureKind(error)) {
      case "host-gone":
        return `${label} isn't in your ssh config any more. Add it back, then Enter to retry · ${close}`
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
  prompt?: AuthPrompt,
): StatusUi {
  switch (phase) {
    case "starting":
      return { dot: "faint", word: "connecting", pulse: true }
    case "prompt":
      return { dot: "amber", word: prompt ?? "needs input", pulse: false }
    case "closed":
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

/** A tab's ssh summary: any pane at a prompt → "prompt"; else any disconnected or failed →
 *  "down"; else null (the tab's ordinary badge applies). */
export function tabRemoteBadge(phases: (RemotePhase | undefined)[]): "prompt" | "down" | null {
  if (phases.includes("prompt")) return "prompt"
  return phases.some((p) => p === "closed" || p === "failed") ? "down" : null
}
