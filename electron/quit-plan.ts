// What `before-quit` does, as a pure decision — the quit ordering is the risky part of the
// PTY drain (see pty-drain.ts), so it's unit-tested here rather than inline in main.ts.

export type QuitPhase = "running" | "draining" | "drained"

export interface QuitState {
  phase: QuitPhase
  confirmed: boolean // the user already said Quit in the dialog
  asking: boolean // that dialog is up now (another ⌘Q / close mustn't stack a second)
  needsConfirm: boolean // live sessions + the confirm setting on + a window to ask in
  livePtys: number // node-ptys not yet exited (closed panes winding down included)
  osEnding: boolean // the OS is logging out / restarting (powerMonitor 'shutdown')
  canAskUnsaved?: boolean // a page to ask what's unsaved (docs/design/FILE_EDITING.md)
  unsavedChecked?: boolean // this quit asked it, and nothing unsaved stops it now
  checkingUnsaved?: boolean // asking it now
  savesInFlight?: number // edited files being written now
  waitingSaves?: boolean // already waiting for them
}

// checkUnsaved = ask the page what's unsaved (it lets its saves land first), then the user if
// anything is (always, setting or not) · waitSaves = hold until the writes in flight land
// (stopping their worker mid-write leaves a file half done).
/** proceed = let it quit · confirm = ask first · drain = hold, end the PTYs, quit again ·
 *  hold = a drain is running · killNow = end them without holding (don't cancel the OS). */
export type QuitStep =
  "proceed" | "confirm" | "drain" | "hold" | "killNow" | "checkUnsaved" | "waitSaves"

export function quitStep(s: QuitState): QuitStep {
  if (s.phase === "drained") return "proceed" // second pass, after the drain
  if (s.phase === "draining") return "hold" // no dialog, no second drain
  // An OS logout can't be held: unsaved text is lost there (the design says so).
  if (!s.osEnding && s.canAskUnsaved && !s.unsavedChecked)
    return s.checkingUnsaved || s.asking ? "hold" : "checkUnsaved"
  if (!s.osEnding && (s.savesInFlight ?? 0) > 0) return s.waitingSaves ? "hold" : "waitSaves"
  // Nor for the live-session confirm: a dialog there makes macOS report the logout cancelled.
  if (s.osEnding) return s.livePtys === 0 ? "proceed" : "killNow"
  if (s.needsConfirm && !s.confirmed) return s.asking ? "hold" : "confirm"
  if (s.livePtys === 0) return "proceed"
  // Holding the quit here would make macOS report "minmux cancelled restart/logout".
  if (s.osEnding) return "killNow"
  return "drain"
}

/** Whether a quit asks first: live sessions, the setting on, and somewhere to ask — macOS asks
 *  window-less too (⌘W leaves the sessions running; ⌘Q later mustn't kill them unasked). */
export function quitNeedsConfirm(o: {
  live: number
  enabled: boolean
  hasWindow: boolean
  platform: string
}): boolean {
  return o.live > 0 && o.enabled && (o.hasWindow || o.platform === "darwin")
}

/** A window `close`: let it close, or cancel it into the guarded quit — macOS's red button,
 *  unless the quit already let it through or it's the menu's plain ⌘W close. */
export function closeStep(o: {
  platform: string
  quitThrough: boolean
  plain: boolean
}): "close" | "quit" {
  return o.platform !== "darwin" || o.quitThrough || o.plain ? "close" : "quit"
}
