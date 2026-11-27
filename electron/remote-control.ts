// Remote control in main (docs/design/REMOTE_CONTROL.md): the device table, the remote-host
// worker's lifecycle from settings, the approval dialog, and the renderer's IPC for Settings.

import { dialog, utilityProcess, type BrowserWindow } from "electron"
import fs from "node:fs"
import path from "node:path"
import { mergeRemoteSettings } from "../src/settings/schema"
import { isPermission, type RemotePanes } from "../src/lib/remote-protocol"
import { AtomicFile } from "./atomic-file"
import type { RemoteView } from "../src/lib/remote-view"
import { DeviceTable, type SetPinResult } from "./remote/devices"
import { RemoteHost, type Decision, type HostProc } from "./remote/host-client"

export interface RemoteControlDeps {
  dir: string // main's build dir (remote-host.js beside it, the renderer at ../renderer)
  configDir: () => string
  readSettings: () => string
  profile: string // "" for the installed app
  devUrl?: string
  window: () => BrowserWindow | null
}

/** 7420 for the installed app, 7421 for a dev build, and one of 7430–7489 per other profile. */
export function autoPort(profile: string): number {
  if (!profile) return 7420
  if (profile === "dev") return 7421
  let h = 0
  for (const ch of profile) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return 7430 + (h % 60)
}

export function setupRemoteControl(deps: RemoteControlDeps) {
  let table: DeviceTable | null = null
  const file = () => path.join(deps.configDir(), "remote-devices.json")
  let writer: AtomicFile | null = null
  let unsaved: string | null = null // the latest contents until its write lands
  const devices = (): DeviceTable => {
    if (table) return table
    let raw: string | null
    try {
      raw = fs.readFileSync(file(), "utf8")
    } catch {
      raw = null
    }
    writer = new AtomicFile(file())
    table = new DeviceTable(raw, {
      save: (c) => {
        unsaved = c
        writer!.write(c)
        void writer!.flushed().then(() => unsaved === c && (unsaved = null))
      },
    })
    return table
  }

  const settings = () => {
    try {
      return mergeRemoteSettings(
        (JSON.parse(deps.readSettings() || "{}") as { remote?: unknown }).remote,
      )
    } catch {
      return mergeRemoteSettings(undefined)
    }
  }

  const send = (channel: string, ...args: unknown[]) => {
    const w = deps.window()
    if (w && !w.isDestroyed()) w.webContents.send(channel, ...args)
  }

  const ask = async (name: string, code: string): Promise<Decision> => {
    const w = deps.window()
    const opts = {
      type: "question" as const,
      buttons: ["Allow", "View only", "Deny"],
      defaultId: 2,
      cancelId: 2,
      noLink: true,
      title: "Remote control",
      message: `${name} wants to control minmux`,
      detail: `Check that the device shows the code ${code}.\n\nAllow lets it read your panes and send messages. View only lets it read them.`,
    }
    const r =
      w && !w.isDestroyed()
        ? await dialog.showMessageBox(w, opts)
        : await dialog.showMessageBox(opts)
    return r.response === 0 ? "allow" : r.response === 1 ? "view" : "deny"
  }

  let lastWanted = false
  const host = new RemoteHost({
    fork: () =>
      utilityProcess.fork(path.join(deps.dir, "remote-host.js"), [], {
        serviceName: "minmux remote",
        stdio: "ignore",
      }) as unknown as HostProc,
    devices,
    ask,
    onChange: () => {
      send("remote:changed")
      if (host.wanted !== lastWanted) {
        lastWanted = host.wanted
        send("remote:wanted", lastWanted)
      }
    },
  })

  const view = (): RemoteView => {
    const s = settings()
    const t = devices()
    return {
      ...host.state,
      enabled: s.enabled,
      port: s.port || autoPort(deps.profile),
      devices: t.list(),
      hasPin: t.hasPin,
      pinUnlockOff: t.pinUnlockOff,
      newerFile: t.newerFile,
    }
  }

  /** Re-reads settings: starts, restarts or stops the worker. */
  const apply = () => {
    const s = settings()
    host.apply(
      s.enabled
        ? {
            port: s.port || autoPort(deps.profile),
            staticDir: path.join(deps.dir, "../renderer"),
            devUrl: deps.devUrl,
          }
        : null,
    )
  }

  // The desktop window is gone (⌘W on macOS keeps sessions running): the list goes stale.
  let lastPanes: RemotePanes | null = null
  const windowClosed = () => {
    if (lastPanes) host.setPanes({ ...lastPanes, stale: true })
  }

  /** The renderer's pane list (pushed only while a client is connected). */
  const setPanes = (panes: unknown) => {
    const p = panes as RemotePanes | null
    if (!p || !Array.isArray(p.panes) || !Array.isArray(p.tabs)) return
    lastPanes = { tabs: p.tabs, panes: p.panes, stale: false }
    host.setPanes(lastPanes)
  }
  const revoke = (id: unknown) => {
    if (typeof id !== "string" || !devices().revoke(id)) return false
    host.drop(id, "revoked")
    send("remote:changed")
    return true
  }
  const rename = (id: unknown, name: unknown) => {
    const ok = typeof id === "string" && typeof name === "string" && devices().rename(id, name)
    if (ok) send("remote:changed")
    return ok
  }
  const setPermission = (id: unknown, p: unknown) => {
    const ok = typeof id === "string" && isPermission(p) && devices().setPermission(id, p)
    // A new permission takes effect on the next connection: its pages reconnect at once.
    if (ok) {
      host.drop(id as string, "off")
      send("remote:changed")
    }
    return ok
  }
  const setPin = async (pin: unknown): Promise<SetPinResult> => {
    if (typeof pin !== "string") return "invalid"
    try {
      const r = await devices().setPin(pin)
      if (r === "ok") send("remote:changed")
      return r
    } catch {
      return "error"
    }
  }

  return {
    apply,
    windowClosed,
    dispose: () => {
      host.dispose()
      // Quitting: an approval or PIN change still queued is written now, not lost.
      if (unsaved !== null) {
        try {
          fs.writeFileSync(file(), unsaved)
        } catch {
          // best-effort
        }
      }
    },
    // IPC (registered in main.ts with the other handlers)
    view,
    setPanes,
    wanted: () => host.wanted,
    revoke,
    rename,
    setPermission,
    setPin,
    disconnectAll: () => host.drop(undefined, "disconnected"),
  }
}
