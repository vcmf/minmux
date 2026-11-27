// Remote control in main (docs/design/REMOTE_CONTROL.md): the device table, the remote-host
// worker's lifecycle from settings, the approval dialog, and the renderer's IPC for Settings.

import { dialog, utilityProcess, type BrowserWindow } from "electron"
import path from "node:path"
import { mergeRemoteSettings } from "../src/settings/schema"
import { isPermission, type RemotePane, type RemotePanes } from "../src/lib/remote-protocol"
import { DeviceFile } from "./remote/device-file"
import type { RemoteView } from "../src/lib/remote-view"
import type { AgentKind } from "../src/lib/agent-graph"
import { chatLeadFor, type ChatLead } from "./agents/chat-lead"
import { Sender } from "./remote/typing"
import { TurnTracker } from "./remote/turns"
import { WaitTracker } from "./remote/waits"
import { DeviceTable, PENDING_MS, type SetPinResult } from "./remote/devices"
import { RemoteHost, type Decision, type HostProc } from "./remote/host-client"

export interface RemoteControlDeps {
  dir: string // main's build dir (remote-host.js beside it, the renderer at ../renderer)
  configDir: () => string
  readSettings: () => string
  profile: string // "" for the installed app
  devUrl?: string
  window: () => BrowserWindow | null
  /** The pane's lead agent session (the resume ledger), when one runs there now. */
  leadOf?: (
    pane: string,
  ) => { agent?: AgentKind; sessionId: string; transcriptPath?: string } | null
  /** Host paths for a transcript a hook reported (a WSL pane's through its distro). */
  transcriptTargets?: (p: string, pane: string) => string[]
  /** The pane's terminal's bracketed-paste mode now (asks the renderer; undefined if it can't). */
  pasteMode?: (pane: string) => Promise<boolean | undefined>
  /** A WSL pane (its agents' files live inside the distro). */
  wslPane?: (pane: string) => boolean
  /** Writes to a pane's PTY as typing would; false when there's no live one. */
  writePty?: (pane: string, data: string) => boolean
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
  // The device table: read once, off main's thread, on first use.
  const store = new DeviceFile(path.join(deps.configDir(), "remote-devices.json"))
  let loading: Promise<DeviceTable> | null = null
  const devices = (): Promise<DeviceTable> =>
    (loading ??= store.read().then((raw) => new DeviceTable(raw, { save: (c) => store.write(c) })))

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

  // The prompt closes itself when the request expires (its answer would do nothing then).
  const ask = async (name: string, code: string): Promise<Decision> => {
    const w = deps.window()
    const signal = AbortSignal.timeout(PENDING_MS)
    if (w && !w.isDestroyed() && w.isMinimized()) w.restore()
    const opts = {
      signal,
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
    if (signal.aborted) return "deny"
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
        if (lastWanted) pushLeads()
      }
    },
    send: async (deviceId, pane, text, id) => {
      const r = await sender.send(deviceId, pane, text, id)
      if (r.ok) {
        const name = (await devices()).list().find((d) => d.id === deviceId)?.name ?? "a device"
        send("remote:typed", pane, name) // the desktop shows who typed
      }
      return r
    },
  })

  const view = async (): Promise<RemoteView> => {
    const s = settings()
    const t = await devices()
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
    if (!lastPanes) return
    lastPanes = { ...lastPanes, stale: true } // every later send keeps saying so
    sendPanes()
  }

  /** The renderer's pane list (pushed only while a client is connected). */
  const setPanes = (panes: unknown) => {
    const p = panes as RemotePanes | null
    if (!p || !Array.isArray(p.panes) || !Array.isArray(p.tabs)) return
    lastPanes = { tabs: p.tabs, panes: p.panes, stale: false }
    sendPanes()
    pushLeads()
  }

  // Messages from devices, typed into panes (checked against the latest pane list).
  const sender = new Sender({
    pane: (id) => lastPanes?.panes.find((p) => p.id === id),
    write: (pane, data) => deps.writePty?.(pane, data) ?? false,
    asking: (pane) => waits.asking(pane),
    between: (pane) => turns.turn(pane) === "between",
    isAgent: (pane) => !!deps.leadOf?.(pane),
    pasteNow: (pane) => deps.pasteMode?.(pane) ?? Promise.resolve(undefined),
    submitted: (pane) => {
      turns.started(pane) // a turn is on now, ahead of its hook: the next message waits
      askingChanged()
    },
    // Main decides, not the worker: the device must still exist, be unlocked and able to send.
    allowed: async (deviceId) => {
      const p = (await devices()).permissionOf(deviceId)
      return p === "send" || p === "keys"
    },
  })

  // Which panes' agents show a dialog right now, from hook events as they land (fresher than the
  // renderer's throttled pane list): a message's Enter must never answer one.
  const waits = new WaitTracker()
  // Whether each pane's agent is between turns: the rule for sending (turns.ts).
  const turns = new TurnTracker()
  let askingNow = "" // what devices were last told: each asking pane and its prompt
  /** The pane list as devices see it: each pane's asking state is main's. */
  const annotated = (p: RemotePanes): RemotePanes => ({
    ...p,
    panes: p.panes.map((x) => {
      const w = waits.waits(x.id)[0]
      const { asking: _old, ...rest } = x
      void _old
      const working = isAgentPane(x) && turns.turn(x.id) !== "between"
      const out = working ? { ...rest, working: true } : rest
      return w ? { ...out, asking: true, ...(w.message ? { detail: w.message } : {}) } : out
    }),
  })
  const isAgentPane = (x: RemotePane) => x.kind === "agent" || !!deps.leadOf?.(x.id)
  const askingKey = (p: RemotePanes) =>
    p.panes
      .flatMap((x) => {
        const w = waits.waits(x.id)[0]
        const working = isAgentPane(x) && turns.turn(x.id) !== "between"
        return w || working ? [`${x.id}\u0000${w?.message ?? ""}\u0000${working}`] : []
      })
      .join("\u0001")
  /** The one way the list reaches devices: remembers what they were told. */
  const sendPanes = () => {
    if (!lastPanes) return
    askingNow = askingKey(lastPanes)
    host.setPanes(annotated(lastPanes))
  }
  /** Re-sends the list when a pane's asking state (or its prompt) changed. */
  const askingChanged = () => {
    if (lastPanes && askingKey(lastPanes) !== askingNow) sendPanes()
  }

  // Each listed pane's lead agent session, for the chat view (sent only while someone's connected).
  let lastLeads = ""
  const pushLeads = () => {
    if (!host.wanted || !lastPanes || !deps.leadOf) return
    const leads: Record<string, ChatLead> = {}
    for (const p of lastPanes.panes) {
      const l = deps.leadOf(p.id)
      const lead = l
        ? chatLeadFor(l, {
            wsl: deps.wslPane?.(p.id) ?? false,
            targets: (t) => deps.transcriptTargets?.(t, p.id) ?? [t],
          })
        : null
      if (lead) leads[p.id] = lead
    }
    const key = JSON.stringify(leads)
    if (key === lastLeads) return
    lastLeads = key
    host.setLeads(leads)
  }

  /** A batch of agent hook events: leads may have moved; the panes' transcripts grew. */
  const isLeadEvent = (ev: { paneId?: string; sessionId?: string; nested?: boolean }) => {
    if (!ev.paneId || ev.nested) return false
    const lead = deps.leadOf?.(ev.paneId)
    return !lead || !ev.sessionId || lead.sessionId === ev.sessionId
  }
  const agentEvents = (
    events: (Parameters<WaitTracker["apply"]>[0] & { sessionId?: string; nested?: boolean })[],
  ) => {
    // Always (a turn or a dialog may begin before anyone connects), and only the pane's lead
    // session: a background or nested session in the same pane says nothing about the lead's TUI.
    for (const ev of events) {
      if (!isLeadEvent(ev)) continue
      waits.apply(ev)
      turns.apply(ev)
    }
    askingChanged()
    if (!host.wanted) return
    pushLeads()
    host.nudge([...new Set(events.flatMap((e) => (e.paneId ? [e.paneId] : [])))])
  }
  const revoke = async (id: unknown) => {
    if (typeof id !== "string" || !(await devices()).revoke(id)) return false
    host.drop(id, "revoked")
    send("remote:changed")
    return true
  }
  const rename = async (id: unknown, name: unknown) => {
    const ok =
      typeof id === "string" && typeof name === "string" && (await devices()).rename(id, name)
    if (ok) send("remote:changed")
    return ok
  }
  const setPermission = async (id: unknown, p: unknown) => {
    const ok = typeof id === "string" && isPermission(p) && (await devices()).setPermission(id, p)
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
      const r = await (await devices()).setPin(pin)
      if (r === "ok") send("remote:changed")
      return r
    } catch {
      return "error"
    }
  }

  return {
    apply,
    windowClosed,
    agentEvents,
    /** Typed at the desktop into a pane: an answer key closes its dialogs. Per keystroke: O(1). */
    localInput: (pane: string, data: string) => {
      if (waits.any && waits.localInput(pane, data)) askingChanged()
      // Enter at the desktop between turns submits a prompt: the turn is on, ahead of its hook.
      if (data === "\r" && turns.turn(pane) === "between") {
        turns.started(pane)
        askingChanged()
      }
    },
    /** A pane's process ended or it closed. */
    paneGone: (pane: string) => {
      waits.drop(pane)
      turns.drop(pane)
      askingChanged()
    },
    dispose: () => {
      host.dispose()
      store.close() // quitting: a change still queued is written now, not lost
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
