// The shell-mark decisions behind resuming Claude sessions — pure, so the rules (the part
// every review round probed) are unit-tested; terminal-manager only applies the actions.
// Marks are the shell integration's OSC 133 C (command started) / D;<exit> (prompt is back).

/** What we know about one terminal's shell, from its OSC 133 marks. */
export interface ShellFlow {
  integrated?: boolean // main injected our integration (undefined = spawn not answered yet)
  seenPrompt: boolean // a D arrived: the shell has shown a prompt at least once
  cmdRunning: boolean // between a C and its D: something runs in the foreground
  replaying: boolean // a reattach's replayed history is being parsed: old marks, no effects
  suspendedJob: boolean // a job was Ctrl-Z'd here: a prompt no longer proves Claude exited
  agentSeen: boolean // an agent session ran here this run → a returning prompt matters
  resumeStage?: "await-prompt" | "typed" // a pending resume: waiting for the prompt / typed
  resumeSawStart: boolean // a C after typing: the next D is OUR command ending
}

export const newShellFlow = (): ShellFlow => ({
  seenPrompt: false,
  cmdRunning: false,
  replaying: true, // until the spawn says it wasn't a reattach (or the replay is parsed)
  suspendedJob: false,
  agentSeen: false,
  resumeSawStart: false,
})

export type Mark = { kind: "C" } | { kind: "D"; code?: number }

export type FlowAction =
  | { type: "shell-idle" } // tell main: the foreground program (Claude) has exited
  | { type: "type-resume" } // the first prompt is here: type the pending resume
  | { type: "fail-resume"; exitCode?: number } // our resume command exited before confirming

/** `133;D;<code>` payload → the exit code (undefined if absent / unparseable). */
export function parseMark(data: string): Mark | null {
  const kind = data.charAt(0)
  if (kind === "C") return { kind: "C" }
  if (kind !== "D") return null
  const code = Number.parseInt(data.slice(2), 10)
  return { kind: "D", code: Number.isFinite(code) ? code : undefined }
}

/** Exit 128+SIGTSTP (146 macOS, 148 Linux): the job was suspended (Ctrl-Z), not ended. */
export const isSuspendCode = (code: number | undefined): boolean => code === 146 || code === 148

/** Fold one mark. `resuming` = the pane's banner is waiting for Claude to confirm. */
export function onMark(
  s: ShellFlow,
  mark: Mark,
  resuming: boolean,
): { next: ShellFlow; actions: FlowAction[] } {
  if (mark.kind === "C") {
    return {
      next: {
        ...s,
        cmdRunning: true,
        resumeSawStart: s.resumeSawStart || s.resumeStage === "typed",
      },
      actions: [],
    }
  }
  const actions: FlowAction[] = []
  const suspended = isSuspendCode(mark.code)
  const next: ShellFlow = { ...s, seenPrompt: true, cmdRunning: false }
  if (suspended) next.suspendedJob = true // stays: we can't tell when that job ends
  // The prompt is back after a command: whatever ran in the foreground (Claude, SessionEnd or
  // not) has exited — unless it was only suspended, or these are replayed old marks.
  if (s.cmdRunning && s.agentSeen && !next.suspendedJob && !s.replaying) {
    actions.push({ type: "shell-idle" })
    next.agentSeen = false
  }
  // Resume: the first prompt → type. After typing, only a D that follows our command's own C
  // means it exited before Claude confirmed; a D without a C is the shell's first prompt
  // arriving late (keystrokes typed ahead on a slow rc).
  if (s.resumeStage === "await-prompt") actions.push({ type: "type-resume" })
  else if (s.resumeStage === "typed" && s.resumeSawStart && resuming && !suspended) {
    actions.push({ type: "fail-resume", exitCode: mark.code })
  }
  return { next, actions }
}

/** Safe to type into this shell: at a prompt, never into a running program. Integration not
 *  known yet → no; an integrated shell must have SHOWN a prompt (its rc may still be running
 *  a `read`); a shell without integration can't tell us → allowed. */
export function canType(s: ShellFlow): boolean {
  if (s.integrated === undefined) return false
  if (s.integrated && !s.seenPrompt) return false
  return !(s.seenPrompt && s.cmdRunning)
}
