// The user's other minmux on the tailnet, as the sidebar lists them (docs/design/REMOTE_CONTROL.md,
// "minmux on another machine"). Main's remote-client worker builds this list.

import type { Permission, RemotePanes } from "./remote-protocol"

/** How the sidebar shows one machine. */
export type MachineState =
  | "new" // not approved yet: "Ask for access"
  | "pairing" // asked: its window shows a prompt with the code
  | "connecting"
  | "connected"
  | "locked" // unused for 24 h (or PIN attempts): ask again
  | "denied" // the last ask was denied or expired
  | "offline" // was reachable, isn't now

export interface MachineView {
  key: string // "<host>:<port>"
  label: string
  state: MachineState
  code?: string // while pairing: the code its prompt shows
  permission?: Permission // once connected
  panes?: RemotePanes // once connected
}

/** A machine's panes by tab, in its order (tabs without panes left out). */
export function panesByTab(
  p: RemotePanes,
): { id: string; title: string; panes: RemotePanes["panes"] }[] {
  return p.tabs
    .map((t) => ({ id: t.id, title: t.title, panes: p.panes.filter((x) => x.tab === t.id) }))
    .filter((g) => g.panes.length > 0)
}

/** What a machine's row says under its name (nothing once connected: its panes show). */
export function machineLine(m: MachineView): string {
  switch (m.state) {
    case "new":
      return "minmux runs there"
    case "pairing":
      return `Allow it on that computer: code ${m.code ?? "…"}`
    case "connecting":
      return "Connecting…"
    case "connected":
      return m.permission === "keys" ? "" : "View only"
    case "locked":
      return "Locked after a day unused"
    case "denied":
      return "Not allowed"
    case "offline":
      return "Not reachable"
  }
}
