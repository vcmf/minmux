// Main ↔ remote-client worker (docs/design/REMOTE_CONTROL.md, "minmux on another machine"). The
// worker finds the user's other minmux on the tailnet, asks each for access once, and relays a
// remote pane's terminal to main, which shows it as a terminal surface like any PTY.

import type { MachineView } from "../../src/lib/remote-machines"

export type { MachineState, MachineView } from "../../src/lib/remote-machines"

export type ToClient =
  | { t: "tokens"; tokens: Record<string, string> } // main's saved tokens, by machine key
  | { t: "list"; on: boolean } // the sidebar lists machines: find them, connect the approved
  | { t: "pair"; key: string }
  | { t: "connect"; key: string } // reconnect a held machine (it disconnected this one)
  | { t: "port"; own: number } // this minmux's own port now (never listed)
  | { t: "forget"; key: string }
  | { t: "open"; sid: string; key: string; pane: string } // a surface shows this remote pane
  | { t: "close"; sid: string }
  | { t: "refresh"; sid: string } // a clean screen again (a reloaded window lost its base)
  | { t: "keys"; sid: string; data: string }
  | { t: "drive"; sid: string; cols: number; rows: number } // the grid its box fits, while in use
  | { t: "undrive"; sid: string } // not in use: the size it asked for isn't asked again
  | { t: "seen" } // the user is at a remote surface: counts as use (the 24 h lock)

export type FromClient =
  | { t: "machines"; machines: MachineView[] }
  | { t: "token"; key: string; token: string | null } // save (or drop) a machine's token
  // A surface's terminal: a clean screen at a size, then output; `note` says why it stopped.
  | { t: "snap"; sid: string; cols: number; rows: number; data: string }
  | { t: "out"; sid: string; data: string }
  | { t: "size"; sid: string; cols: number; rows: number }
  | { t: "note"; sid: string; text: string }
