// What Settings shows about remote control (main → renderer), shared by both sides.
import type { Permission } from "./remote-protocol"

/** An approved device (no secrets). */
export interface DeviceView {
  id: string
  name: string
  permission: Permission
  addedAt: number
  lastSeen: number
  locked: boolean
}

/** The remote-host worker's state. */
export type HostStatus =
  | { state: "starting" }
  | { state: "listening"; url: string; machine: string; addresses: string[] }
  | {
      state: "error"
      reason: "missing" | "stopped" | "signed-out" | "tagged" | "port" | "error"
      detail?: string
    }

/** A device connected right now. */
export interface ClientInfo {
  deviceId: string
  name: string
}

export interface RemoteView {
  status: HostStatus | { state: "off" }
  clients: ClientInfo[]
  enabled: boolean
  port: number
  devices: DeviceView[]
  hasPin: boolean
  pinUnlockOff: boolean
  newerFile: boolean
}
