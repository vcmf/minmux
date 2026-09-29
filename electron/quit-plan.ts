// What `before-quit` does, as a pure decision — the quit ordering is the risky part of the
// PTY drain (see pty-drain.ts), so it's unit-tested here rather than inline in main.ts.

export type QuitPhase = "running" | "draining" | "drained"

export interface QuitState {
  phase: QuitPhase
  confirmed: boolean // the user already said Quit in the dialog
  needsConfirm: boolean // live sessions + the confirm setting on + a window to ask in
  livePtys: number // node-ptys not yet exited (closed panes winding down included)
  osEnding: boolean // the OS is logging out / restarting (powerMonitor 'shutdown')
}

/** proceed = let it quit · confirm = ask first · drain = hold, end the PTYs, quit again ·
 *  hold = a drain is running · killNow = end them without holding (don't cancel the OS). */
export type QuitStep = "proceed" | "confirm" | "drain" | "hold" | "killNow"

export function quitStep(s: QuitState): QuitStep {
  if (s.phase === "drained") return "proceed" // second pass, after the drain
  if (s.phase === "draining") return "hold" // no dialog, no second drain
  if (s.needsConfirm && !s.confirmed) return "confirm"
  if (s.livePtys === 0) return "proceed"
  // Holding the quit here would make macOS report "minmux cancelled restart/logout".
  if (s.osEnding) return "killNow"
  return "drain"
}
