// The connection lifecycle of an ssh pane, as pure rules (terminal-manager does the I/O).

import type { SshSettings } from "./ssh-validate"
import { hasControlChar } from "./control-chars"

/** Where an ssh pane's connection is. `waiting` / `closed` / `failed` wait for Enter. */
export type RemotePhase =
  | "starting" // spawn (or reattach) requested
  | "live" // ssh is running
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

/** The phase once main answers a start; a later exit or error already moved it on. */
export function afterStart(phase: RemotePhase, started: boolean | undefined): RemotePhase {
  if (phase !== "starting") return phase
  return started === false ? "waiting" : "live"
}

/** A key typed into the pane: to the shell while it runs; Enter connects an idle pane; other
 *  keys are dropped (never sent to a host that isn't there, nor echoed ahead of a prompt). */
export function onKey(phase: RemotePhase, data: string): "forward" | "connect" | "drop" {
  if (!isIdle(phase)) return "forward"
  return data === "\r" ? "connect" : "drop"
}

/** What an idle pane says, after `[smterm]`. */
export function idleMessage(
  phase: RemoteIdle,
  label: string,
  info?: { code?: number; signal?: number; error?: string },
): string {
  if (phase === "waiting") return `${label} — press Enter to connect`
  if (phase === "failed") {
    return `couldn't connect to ${label}: ${cleanError(info?.error)} — press Enter to retry`
  }
  const code = info?.code ?? 0
  const signal = info?.signal ?? 0
  if (code === 0 && !signal) return `session on ${label} ended — press Enter to start a new one`
  const why = signal ? `signal ${signal}` : `code ${code}`
  return `connection to ${label} closed (${why}) — press Enter to reconnect`
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
