// Resuming agent sessions on relaunch — types shared with the main process
// (electron/agent-sessions.ts) + the renderer's per-terminal banner state.

import type { AgentKind } from "./agent-graph"
import { posixQuote } from "./shell-quote"

/** What main says to do for one restored terminal. */
export interface ResumePlan {
  agent?: AgentKind // whose session (absent = Claude: plans from before multi-agent)
  status: "resume" | "skip"
  sessionId: string
  cwd: string // spawn the shell here — Claude's transcripts are keyed by this project dir
  name?: string // the session's /rename, for the banner
  command?: string // `claude --resume <id> [--permission-mode <m>]` (validated in main)
  env?: Record<string, string> // for the command, in POSIX shells (OpenCode's resume id)
  reason?: string // why it's skipped
  cwdUnverified?: boolean // its stat timed out (hung mount): don't use it as a spawn cwd
}

/** A terminal's resume banner. */
export type ResumeState =
  | { phase: "pending"; plan: ResumePlan } // auto: waiting for the shell prompt to type it
  | { phase: "offer"; plan: ResumePlan } // ask mode: [Resume] [Dismiss]
  | { phase: "resuming"; plan: ResumePlan } // typed; waiting for the agent's SessionStart
  | { phase: "waiting"; plan: ResumePlan } // still running unconfirmed: on a screen of its own
  | { phase: "resumed"; plan: ResumePlan }
  | { phase: "failed"; plan: ResumePlan; exitCode?: number } // exited before confirming / timed out
  | { phase: "skipped"; plan: ResumePlan } // preflight failed (e.g. transcript gone)
  | { phase: "sent"; plan: ResumePlan } // typed into a shell without integration: can't confirm

import { shellType } from "./session-label"

// Shells known to take `cd -- '…' && cmd` with POSIX single-quote escaping ('\''). NOT fish:
// there a backslash inside single quotes escapes the quote, so a crafted path could break out.
// WSL panes run a Linux shell. Anything else (fish, pwsh, cmd, nushell…) gets no typed cd.
const POSIX_SHELLS = new Set(["zsh", "bash", "sh", "dash", "ksh", "wsl"])

/** Can we type a POSIX `cd -- '…' && …` (and ^U line-kill) into this shell? */
export const isPosixShell = (command: string): boolean => POSIX_SHELLS.has(shellType(command))

/** `cd -- '<cwd>' && <command>` with the path single-quoted for a POSIX shell (a path from a
 *  hook payload never gets to break out of the quotes). */
export const withCd = (cwd: string, command: string): string =>
  `cd -- ${posixQuote(cwd)} && ${command}`

/** `K=V command` for a POSIX shell (names that aren't plain env names are left out). */
export const withEnv = (env: Record<string, string> | undefined, command: string): string =>
  Object.entries(env ?? {})
    .filter(([k]) => /^[A-Z_][A-Z0-9_]*$/.test(k))
    .map(([k, v]) => `${k}=${posixQuote(v)} `)
    .join("") + command

/** A session's banner label: its name, else its id's first block (or 12 characters). */
export const sessionLabel = (plan: ResumePlan): string =>
  plan.name?.trim() ||
  (plan.sessionId.includes("-") ? plan.sessionId.split("-")[0] : plan.sessionId.slice(0, 12)) ||
  "session"
