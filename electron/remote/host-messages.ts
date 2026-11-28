// Messages between main and the remote-host worker (docs/design/REMOTE_CONTROL.md). The worker
// asks; main decides (devices, tokens, PIN) and answers by request id.

import type { AnswerRefusal, RemotePanes, SendRefusal } from "../../src/lib/remote-protocol"
import type { ChatLead } from "../agents/chat-lead"
import type { TermSnapshot } from "./term-mirror"
import type { ClientInfo, HostStatus } from "../../src/lib/remote-view"
import type { AuthResult, UnlockResult } from "./devices"

export type { ClientInfo, HostStatus }

export interface HostConfig {
  port: number
  staticDir: string // the built web app (out/renderer)
  devUrl?: string // dev builds: proxy the web app to the Vite dev server
}

export type PendingAnswer =
  | { state: "pending"; code: string }
  | { state: "approved"; token: string }
  | { state: "denied" }
  | { state: "expired" }

/** Requests the worker makes of main (answered with the matching `RpcResult`). */
export type RpcCall =
  | { op: "auth"; token: string | null; nodeId: string }
  | { op: "approve"; nodeId: string; name: string; machine?: boolean } // machine: another minmux
  | { op: "pending"; id: string; nodeId: string }
  | { op: "unlock"; token: string | null; nodeId: string; pin: string }
  | { op: "send"; deviceId: string; pane: string; text: string; id: string }
  | { op: "snapshot"; pane: string } // starts the pane's tap
  | { op: "keys"; deviceId: string; pane: string; data: string }
  | { op: "answerable"; pane: string } // does this pane's agent take answers by number
  | {
      op: "answer"
      deviceId: string
      pane: string
      waitId: string
      n: number
      seen: string // the dialog the device was shown (dialogSignature)
      deadline: number // ms epoch: past it, main types nothing (the worker gave up waiting)
    }

export type RpcResult =
  | { op: "auth"; result: AuthResult }
  | { op: "approve"; result: { id: string } | { error: "limited" | "readonly" } }
  | { op: "pending"; result: PendingAnswer }
  | { op: "unlock"; result: UnlockResult }
  | { op: "send"; result: { ok: boolean; reason?: SendRefusal } }
  | { op: "snapshot"; result: TermSnapshot | null | "failed" } // null: no such pane
  | { op: "keys"; result: boolean }
  | { op: "answerable"; result: boolean }
  | { op: "answer"; result: { ok: boolean; reason?: AnswerRefusal } }

/** Worker → main. */
export type FromHost =
  | { t: "status"; status: HostStatus }
  | { t: "clients"; clients: ClientInfo[] }
  | { t: "touch"; deviceId: string }
  | { t: "untap"; pane: string } // nobody watches its terminal any more
  // Another minmux sets a pane's size (keys devices), or stops (pane omitted: all of its panes).
  | { t: "drive"; deviceId: string; name: string; pane: string; cols: number; rows: number }
  | { t: "release"; deviceId: string; pane?: string }
  | { t: "rpc"; id: number; call: RpcCall }

/** Main → worker. */
export type ToHost =
  | { t: "config"; config: HostConfig }
  | { t: "panes"; panes: RemotePanes }
  | { t: "leads"; leads: Record<string, ChatLead> } // each pane's lead agent session
  | { t: "nudge"; panes: string[] } // these panes' agents did something: read their transcripts
  | { t: "tout"; pane: string; epoch: number; offset: number; data: string } // a tapped batch
  | { t: "treset"; pane: string } // in-flight output was dropped (reattach): snapshot again
  | { t: "tsize"; pane: string; cols: number; rows: number }
  | { t: "rpc"; id: number; result: RpcResult }
  | {
      t: "drop"
      deviceId?: string
      reason: "revoked" | "off" | "quitting" | "locked" | "disconnected"
    } // close sockets
