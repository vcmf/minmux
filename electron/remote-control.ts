// Remote control in main (docs/design/REMOTE_CONTROL.md): the device table, the remote-host
// worker's lifecycle from settings, the approval dialog, and the renderer's IPC for Settings.

import { dialog, ipcMain, utilityProcess, type BrowserWindow } from "electron"
import fs from "node:fs"
import path from "node:path"
import { mergeRemoteSettings } from "../src/settings/schema"
import { isPermission, type RemotePanes } from "../src/lib/remote-protocol"
import { AtomicFile } from "./atomic-file"
import type { RemoteView } from "../src/lib/remote-view"
import { DeviceTable } from "./remote/devices"
import { RemoteHost, type Decision, type HostProc } from "./remote/host-client"

export interface RemoteControlDeps {
  dir: string // main's build dir (remote-host.js beside it, the renderer at ../renderer)
  configDir: () => string
  readSettings: () => string
  profile: string // "" for the installed app
  devUrl?: string
  window: () => BrowserWindow | null
}

export const autoPort = (profile: string) => (profile ? 7421 : 7420)

export function setupRemoteControl(deps: RemoteControlDeps) {
  let table: DeviceTable | null = null
  const file = () => path.join(deps.configDir(), "remote-devices.json")
  let writer: AtomicFile | null = null
  const devices = (): DeviceTable => {
    if (table) return table
    let raw: string | null
    try {
      raw = fs.readFileSync(file(), "utf8")
    } catch {
      raw = null
    }
    writer = new AtomicFile(file())
    table = new DeviceTable(raw, { save: (c) => writer!.write(c) })
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

  ipcMain.handle("remote:view", () => view())
  ipcMain.on("remote:panes", (_e, panes: RemotePanes) => {
    if (!panes || !Array.isArray(panes.panes) || !Array.isArray(panes.tabs)) return
    lastPanes = { tabs: panes.tabs, panes: panes.panes, stale: false }
    host.setPanes(lastPanes)
  })
  ipcMain.handle("remote:wanted", () => host.wanted)
  ipcMain.handle("remote:revoke", (_e, id: unknown) => {
    if (typeof id !== "string" || !devices().revoke(id)) return false
    host.drop(id, "revoked")
    send("remote:changed")
    return true
  })
  ipcMain.handle("remote:rename", (_e, id: unknown, name: unknown) => {
    const ok = typeof id === "string" && typeof name === "string" && devices().rename(id, name)
    if (ok) send("remote:changed")
    return ok
  })
  ipcMain.handle("remote:permission", (_e, id: unknown, p: unknown) => {
    const ok = typeof id === "string" && isPermission(p) && devices().setPermission(id, p)
    // A new permission takes effect on the next connection: its pages reconnect at once.
    if (ok) {
      host.drop(id as string, "off")
      send("remote:changed")
    }
    return ok
  })
  ipcMain.handle("remote:set-pin", async (_e, pin: unknown) => {
    const ok = typeof pin === "string" && (await devices().setPin(pin))
    if (ok) send("remote:changed")
    return ok
  })
  ipcMain.handle("remote:disconnect-all", () => {
    host.drop(undefined, "off")
    return true
  })

  return {
    apply,
    windowClosed,
    dispose: () => host.dispose(),
  }
}
