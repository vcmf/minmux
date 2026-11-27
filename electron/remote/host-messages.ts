// Messages between main and the remote-host worker (docs/design/REMOTE_CONTROL.md). The worker
// asks; main decides (devices, tokens, PIN) and answers by request id.

import type { RemotePanes } from "../../src/lib/remote-protocol"
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
  | { op: "approve"; nodeId: string; name: string }
  | { op: "pending"; id: string; nodeId: string }
  | { op: "unlock"; token: string | null; nodeId: string; pin: string }

export type RpcResult =
  | { op: "auth"; result: AuthResult }
  | { op: "approve"; result: { id: string } | { error: "limited" | "readonly" } }
  | { op: "pending"; result: PendingAnswer }
  | { op: "unlock"; result: UnlockResult }

/** Worker → main. */
export type FromHost =
  | { t: "status"; status: HostStatus }
  | { t: "clients"; clients: ClientInfo[] }
  | { t: "touch"; deviceId: string }
  | { t: "rpc"; id: number; call: RpcCall }

/** Main → worker. */
export type ToHost =
  | { t: "config"; config: HostConfig }
  | { t: "panes"; panes: RemotePanes }
  | { t: "rpc"; id: number; result: RpcResult }
  | {
      t: "drop"
      deviceId?: string
      reason: "revoked" | "off" | "quitting" | "locked" | "disconnected"
    } // close sockets
