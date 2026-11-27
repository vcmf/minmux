// Remote control's wire protocol (docs/design/REMOTE_CONTROL.md): shared by the remote-host
// worker and the phone's web app. Client messages are untrusted: parseClientMessage checks
// every field and drops anything else.

import type { ChatItem } from "./remote-chat"

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
  paste?: boolean // its program turned on bracketed paste (how a message is typed into it)
  asking?: boolean // its agent shows a dialog now (main's wait tracker; not the idle reminder)
  waitId?: string // …which one (a device names it when answering)
  working?: boolean // its agent is mid-turn (or main hasn't seen it stop): no message until then
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

export type ClientMessage =
  | { t: "hello"; v: number; client: "web" | "minmux" }
  | { t: "seen" } // the page is in front of its user: counts as use (the 24 h lock)
  | { t: "watch"; pane: string } // start the chat feed for a pane
  | { t: "unwatch"; pane: string }
  | { t: "more"; pane: string; before: string; seq?: number } // older items, before this one
  | { t: "send"; pane: string; text: string; id: string } // a message for the pane's agent or shell
  | { t: "term"; pane: string; on: boolean } // follow (or stop) the pane's terminal
  | { t: "keys"; pane: string; data: string } // raw keys (devices allowed them)
  | { t: "dialog"; pane: string } // what the pane's dialog offers, read from its screen
  | { t: "answer"; pane: string; waitId: string; n: number; label: string }

export const SEEN_EVERY_MS = 60_000

export type HostMessage =
  | { t: "welcome"; v: number; machine: string; device: string; permission: Permission }
  | { t: "panes"; panes: RemotePanes }
  | { t: "tick" } // every 15 s: the page's sign the connection is alive (it can't see pings)
  | {
      t: "chat"
      pane: string
      items: ChatItem[]
      reset?: boolean // replaces what the page has (a new watch, a new session in the pane)
      older?: boolean // items from a `more`: they go before the ones the page has
      more?: boolean // there are older items still
      unavailable?: "no-agent" | "error" // nothing to show as chat (its Terminal view still works)
    }
  | { t: "ack"; id: string; ok: boolean; reason?: SendRefusal }
  // The terminal view: a clean start (screen + recent scrollback), then output as it comes.
  | { t: "tsnap"; pane: string; cols: number; rows: number; data: string; gone?: boolean }
  | { t: "tout"; pane: string; data: string }
  | { t: "tsize"; pane: string; cols: number; rows: number }
  // The pane's dialog as its screen shows it (null: none there); answerable: buttons may type.
  | { t: "dialog"; pane: string; dialog: Dialog | null; answerable: boolean }
  | { t: "answered"; pane: string; waitId: string; ok: boolean; reason?: AnswerRefusal }
  | { t: "locked"; reason: LockReason }
  | { t: "error"; code: string; message: string }
  | { t: "bye"; reason: ByeReason }

/** Why a message wasn't sent. */
export type SendRefusal =
  | "not-allowed" // view-only device
  | "waiting" // the agent is asking something: answer on the desktop
  | "working" // the agent is mid-turn: it takes a message once it stops
  | "held" // pasted, but the agent started asking before Enter: not submitted
  | "no-pane"
  | "not-started"
  | "empty"
  | "multiline" // several lines for a program without bracketed paste: they'd run one by one
  | "error"

export const SEND_MAX = 16 * 1024

/** Why an answer wasn't typed. */
export type AnswerRefusal =
  | "not-allowed" // view-only device
  | "stale" // that dialog isn't the open one any more
  | "changed" // the screen no longer shows that option
  | "unsupported" // this agent's dialogs are answered in the Terminal view
  | "error"

export interface DialogOption {
  n: number
  label: string
}
export interface Dialog {
  question: string
  options: DialogOption[]
}

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
    case "seen":
      return { t: "seen" }
    case "watch":
    case "unwatch":
      return typeof m.pane === "string" && m.pane.length <= 200 ? { t: m.t, pane: m.pane } : null
    case "more":
      return typeof m.pane === "string" &&
        m.pane.length <= 200 &&
        typeof m.before === "string" &&
        m.before.length <= 200
        ? {
            t: "more",
            pane: m.pane,
            before: m.before,
            ...(typeof m.seq === "number" ? { seq: m.seq } : {}),
          }
        : null
    case "term":
      return typeof m.pane === "string" && m.pane.length <= 200 && typeof m.on === "boolean"
        ? { t: "term", pane: m.pane, on: m.on }
        : null
    case "keys":
      return typeof m.pane === "string" &&
        m.pane.length <= 200 &&
        typeof m.data === "string" &&
        m.data.length > 0 &&
        m.data.length <= 1024
        ? { t: "keys", pane: m.pane, data: m.data }
        : null
    case "dialog":
      return typeof m.pane === "string" && m.pane.length <= 200
        ? { t: "dialog", pane: m.pane }
        : null
    case "answer":
      return typeof m.pane === "string" &&
        m.pane.length <= 200 &&
        typeof m.waitId === "string" &&
        m.waitId.length <= 40 &&
        typeof m.n === "number" &&
        Number.isInteger(m.n) &&
        m.n >= 1 &&
        m.n <= 9 &&
        typeof m.label === "string" &&
        m.label.length <= 300
        ? { t: "answer", pane: m.pane, waitId: m.waitId, n: m.n, label: m.label }
        : null
    case "send":
      return typeof m.pane === "string" &&
        m.pane.length <= 200 &&
        typeof m.text === "string" &&
        m.text.length <= SEND_MAX &&
        typeof m.id === "string" &&
        /^[\w-]{1,64}$/.test(m.id)
        ? { t: "send", pane: m.pane, text: m.text, id: m.id }
        : null
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
