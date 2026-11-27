// Remote control's wire protocol (docs/design/REMOTE_CONTROL.md): shared by the remote-host
// worker and the phone's web app. Client messages are untrusted: parseClientMessage checks
// every field and drops anything else.

export const PROTOCOL_VERSION = 1
export const TICK_MS = 15_000
export const DEAD_AFTER_MS = 35_000

/** What a device may do. "view" reads; "send" also writes messages and answers; "keys" raw input. */
export type Permission = "view" | "send" | "keys"
export const PERMISSIONS: readonly Permission[] = ["view", "send", "keys"]
export const isPermission = (v: unknown): v is Permission =>
  typeof v === "string" && (PERMISSIONS as readonly string[]).includes(v)

/** A pane's status as the phone shows it (agent panes from the agent graph, else the shell's). */
export type RemoteStatus = "working" | "waiting" | "idle"

/** One terminal session, as listed to remote clients. */
export interface RemotePane {
  id: string // the terminal's session id
  tab: string // its tab's id
  title: string
  kind: "agent" | "shell" | "ssh"
  agent?: "claude" | "codex" | "opencode"
  status: RemoteStatus
  detail?: string // why it needs input, when known
  cwd?: string
  started: boolean // false: a restored pane in a tab the desktop hasn't shown yet
}

export interface RemoteTab {
  id: string
  title: string
}

/** The full pane list. `stale`: the desktop window is closed, the list may be out of date. */
export interface RemotePanes {
  tabs: RemoteTab[]
  panes: RemotePane[]
  stale: boolean
}

export type ClientMessage = { t: "hello"; v: number; client: "web" | "minmux" }

export type HostMessage =
  | { t: "welcome"; v: number; machine: string; device: string; permission: Permission }
  | { t: "panes"; panes: RemotePanes }
  | { t: "tick" } // every 15 s: the page's sign the connection is alive (it can't see pings)
  | { t: "locked"; reason: LockReason }
  | { t: "error"; code: string; message: string }
  | { t: "bye"; reason: ByeReason }

export type LockReason = "idle" | "pin-attempts" | "expired"
// disconnected: "Disconnect all" on the desktop (the page doesn't reconnect by itself).
export type ByeReason = "revoked" | "off" | "quitting" | "version" | "locked" | "disconnected"

/** What GET /api/session tells the page before it opens a socket. */
export type SessionState =
  | { state: "ok"; machine: string; device: string }
  | { state: "locked"; machine: string; device: string; pin: boolean } // pin: unlocking by PIN is possible
  | { state: "none"; machine: string } // no device yet: ask for access

/** What GET /api/pending/<id> answers while an approval is pending. */
export type PendingState =
  | { state: "pending"; code: string; machine: string }
  | { state: "approved" }
  | { state: "denied" }
  | { state: "expired" }

const MAX_MESSAGE = 64 * 1024

/** Parses one client frame; null for anything malformed or unknown. */
export function parseClientMessage(raw: unknown): ClientMessage | null {
  if (typeof raw !== "string" || raw.length > MAX_MESSAGE) return null
  let o: unknown
  try {
    o = JSON.parse(raw)
  } catch {
    return null
  }
  if (!o || typeof o !== "object") return null
  const m = o as Record<string, unknown>
  switch (m.t) {
    case "hello":
      if (typeof m.v !== "number" || (m.client !== "web" && m.client !== "minmux")) return null
      return { t: "hello", v: m.v, client: m.client }
    default:
      return null
  }
}

/** Parses a host frame on the client side (trusts the shape, checks the tag). */
export function parseHostMessage(raw: unknown): HostMessage | null {
  if (typeof raw !== "string") return null
  try {
    const o = JSON.parse(raw) as { t?: unknown }
    return o && typeof o.t === "string" ? (o as HostMessage) : null
  } catch {
    return null
  }
}
