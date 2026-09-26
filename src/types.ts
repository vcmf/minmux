export interface ShellOption {
  id: string
  label: string
  command: string
  args: string[]
}

/** Which `ssh` runs a remote session: the host's own, or one inside a WSL distro. */
export type SshEnv = "native" | `wsl:${string}`

/** Which SSH host a session runs on; main builds the ssh argv from this at spawn. */
export interface RemoteRef {
  hostId: string // "native:<alias>" | "wsl:<distro>:<alias>" | "settings:<name>"
  label: string // display name
  target: string // the destination `ssh` gets (an alias or user@host)
  env: SshEnv
  extraArgs?: string[] // extra ssh flags (settings-defined hosts only)
  ownMux?: true // the host's ssh config sets ControlMaster/ControlPath — don't add ours
}

/** A saved host as the sidebar lists it. */
export interface SshHost extends RemoteRef {
  source: "config" | "settings"
  detail?: string // "user@hostname:port" subline
}

import type { SessionStatus } from "./lib/session-status"

export interface Session {
  id: string
  title: string
  command: string
  args: string[]
  status: SessionStatus
  unread: boolean
  running?: boolean // a command/agent is executing (OSC 133 C..D)
  cwd?: string // reported by the shell via OSC 7; drives the git diff panel
  oscTitle?: string // raw window title from OSC 0/2 (a program may set it)
  detail?: string // why it needs attention (OSC-9 message / "needs input")
}

/** A pane: terminals ("surfaces") stacked as tabs; stable `id`, only the active one shows. */
export interface PaneLeaf {
  type: "leaf"
  id: string
  sessionIds: string[]
  activeSessionId: string
}

/** Where a dragged surface lands in a pane: an edge (new split) or the centre (join). */
export type DropZone = "left" | "right" | "top" | "bottom" | "center"

/** A tab's layout: a binary tree of panes (leaves) and splits. */
export type PaneNode =
  | PaneLeaf
  | {
      type: "split"
      id: string
      direction: "row" | "column"
      children: [PaneNode, PaneNode]
    }

export interface Tab {
  id: string
  title: string
  root: PaneNode
  activeSessionId: string
}
