// minmux on another machine, in main (docs/design/REMOTE_CONTROL.md): the remote-client worker's
// lifecycle, the machines' tokens (a 0600 file, like ssh keys and gh's tokens: the OS keychain
// can block main or prompt), and remote surfaces: a remote pane shown
// as a terminal surface. To the renderer such a surface is a PTY like any other (pty:data,
// pty:write, reattach after a reload); its bytes come from the worker, never from node-pty.

import path from "node:path"
import { OutputBuffer } from "./output-buffer"
import { DeviceFile } from "./remote/device-file"
import type { FromClient, MachineView, ToClient } from "./remote/client-messages"

export interface ClientProc {
  postMessage(m: unknown): void
  on(ev: "message", fn: (m: unknown) => void): unknown
  on(ev: "exit", fn: (code: number) => void): unknown
  kill(): boolean
}

/** Where a remote surface's pane lives. */
export interface PeerRef {
  key: string // the machine: "<host>:<port>"
  pane: string // its session id there
}

export interface Sender {
  send(channel: string, ...args: unknown[]): void
  isDestroyed(): boolean
}

export interface RemoteMachinesDeps {
  configDir: () => string
  fork: () => ClientProc
  /** The machines list changed: to the renderer. */
  onMachines: (list: MachineView[]) => void
  draining?: () => boolean
}

interface Surface {
  sid: string
  ref: PeerRef
  sender: Sender
  buffer: OutputBuffer // since the last clean screen: replayed after a renderer reload
  since: number // chars pushed since that clean screen (past the buffer's size, it's gone)
  size?: { cols: number; rows: number }
}

const REPLAY_BYTES = 256 * 1024
const IDLE_STOP_MS = 30_000 // no list shown, no surface: the worker stops after this

/** Is this a valid surface reference (from the renderer, untrusted shape)? */
export function peerRefOf(v: unknown): PeerRef | null {
  if (!v || typeof v !== "object") return null
  const o = v as Record<string, unknown>
  if (typeof o.key !== "string" || typeof o.pane !== "string") return null
  if (!/^[\w.:[\]-]{1,300}:\d{1,5}$/.test(o.key) || !o.pane || o.pane.length > 200) return null
  return { key: o.key, pane: o.pane }
}

export function setupRemoteMachines(d: RemoteMachinesDeps) {
  const file = new DeviceFile(path.join(d.configDir(), "remote-machines.json"))
  let tokens: Record<string, string> | null = null
  let loading: Promise<Record<string, string>> | null = null
  let proc: ClientProc | null = null
  let ready = false // the worker has its tokens: surfaces may be opened
  let listing = false
  let stopTimer: ReturnType<typeof setTimeout> | null = null
  let restartTimer: ReturnType<typeof setTimeout> | null = null
  let crashes = 0 // in a row, each before the worker got its tokens: the restart backs off
  let disposed = false
  let machines: MachineView[] = []
  const surfaces = new Map<string, Surface>()

  const loadTokens = () =>
    (loading ??= file.read().then((raw) => {
      const out: Record<string, string> = {}
      try {
        const o = JSON.parse(raw ?? "{}") as { machines?: Record<string, { token?: unknown }> }
        for (const [k, v] of Object.entries(o.machines ?? {})) {
          if (typeof v?.token === "string" && v.token) out[k] = v.token
        }
      } catch {
        // unreadable: start over (each machine asks again)
      }
      tokens = out
      return out
    }))

  function saveTokens() {
    if (!tokens) return
    const machinesOut: Record<string, { token: string }> = {}
    for (const [k, t] of Object.entries(tokens)) machinesOut[k] = { token: t }
    file.write(JSON.stringify({ v: 1, machines: machinesOut }, null, 2))
  }

  const post = (m: ToClient) => proc?.postMessage(m)
  const postReady = (m: ToClient) => ready && post(m)

  function wanted() {
    return listing || surfaces.size > 0
  }

  function ensure() {
    if (stopTimer) clearTimeout(stopTimer)
    stopTimer = null
    if (!wanted()) {
      if (proc)
        stopTimer = setTimeout(() => {
          stopTimer = null
          if (!wanted()) stop()
        }, IDLE_STOP_MS)
      return
    }
    if (proc || restartTimer || disposed || d.draining?.()) return
    const p = d.fork()
    proc = p
    ready = false
    p.on("message", (m) => onWorker(p, m as FromClient))
    p.on("exit", () => {
      if (proc !== p) return
      proc = null
      ready = false
      machines = []
      d.onMachines(machines)
      // Died while wanted: start again, later each time it dies at once (surfaces get a clean
      // screen when it reconnects).
      crashes++
      if (wanted() && !disposed)
        restartTimer = setTimeout(
          () => {
            restartTimer = null
            ensure()
          },
          Math.min(60_000, 1000 * 2 ** Math.min(crashes - 1, 6)),
        )
    })
    void loadTokens().then((t) => {
      if (proc !== p) return
      ready = true
      setTimeout(() => proc === p && (crashes = 0), 10_000) // up a while: not crashing
      post({ t: "tokens", tokens: t })
      post({ t: "list", on: listing })
      for (const s of surfaces.values()) post({ t: "open", sid: s.sid, ...s.ref })
    })
  }

  function stop() {
    const p = proc
    proc = null
    ready = false
    p?.kill()
    machines = []
    d.onMachines(machines)
  }

  function emit(s: Surface, data: string) {
    if (d.draining?.() || s.sender.isDestroyed()) return
    s.sender.send(`pty:data:${s.sid}`, data)
  }

  function pin(s: Surface) {
    if (!s.size || d.draining?.() || s.sender.isDestroyed()) return
    s.sender.send(`pty:pinned:${s.sid}`, s.size.cols, s.size.rows)
  }

  function onWorker(p: ClientProc, m: FromClient) {
    if (proc !== p) return
    switch (m.t) {
      case "machines":
        machines = m.machines
        return d.onMachines(machines)
      case "token":
        void loadTokens().then((t) => {
          if (m.token) t[m.key] = m.token
          else delete t[m.key]
          saveTokens()
        })
        return
      case "snap": {
        const s = surfaces.get(m.sid)
        if (!s) return
        s.size = { cols: m.cols, rows: m.rows }
        // A clean screen: the size first (applied after what's already written), then a reset.
        const data = "\x1bc" + m.data
        s.buffer.clear()
        s.buffer.push(data)
        s.since = data.length
        pin(s)
        return emit(s, data)
      }
      case "out": {
        const s = surfaces.get(m.sid)
        if (!s) return
        s.buffer.push(m.data)
        s.since += m.data.length
        return emit(s, m.data)
      }
      case "size": {
        const s = surfaces.get(m.sid)
        if (!s) return
        s.size = { cols: m.cols, rows: m.rows }
        return pin(s)
      }
      case "note": {
        const s = surfaces.get(m.sid)
        if (!s) return
        const text = `\r\n\x1b[2m[${m.text}]\x1b[0m\r\n`
        s.buffer.push(text)
        s.since += text.length
        return emit(s, text)
      }
    }
  }

  return {
    /** A renderer asks for a remote surface: start following it, or reattach after a reload. */
    spawn(sender: Sender, sid: string, ref: PeerRef): { reattached: boolean } {
      const had = surfaces.get(sid)
      if (had && had.ref.key === ref.key && had.ref.pane === ref.pane) {
        had.sender = sender
        pin(had)
        // Its clean screen still in the buffer: replayed. Either way a fresh one follows (cheap,
        // and the buffer's tail alone would draw cursor moves on an empty screen).
        if (had.since <= REPLAY_BYTES) emit(had, had.buffer.dump())
        postReady({ t: "refresh", sid })
        return { reattached: true }
      }
      if (had) postReady({ t: "close", sid })
      const s: Surface = { sid, ref, sender, buffer: new OutputBuffer(REPLAY_BYTES), since: 0 }
      surfaces.set(sid, s)
      ensure()
      postReady({ t: "open", sid, ...ref }) // else opened once the worker has its tokens
      return { reattached: false }
    },
    has: (sid: string) => surfaces.has(sid),
    ids: () => [...surfaces.keys()],
    write(sid: string, data: string) {
      if (!surfaces.has(sid)) return
      post({ t: "keys", sid, data })
      post({ t: "seen" })
    },
    kill(sid: string) {
      if (!surfaces.delete(sid)) return
      post({ t: "close", sid })
      ensure()
    },
    /** The sidebar shows (or hides) the machines list. */
    list(on: boolean) {
      listing = on
      ensure()
      postReady({ t: "list", on }) // else sent once the worker has its tokens
      if (on) d.onMachines(machines)
    },
    pair: (key: string) => post({ t: "pair", key }),
    forget(key: string) {
      post({ t: "forget", key })
      void loadTokens().then((t) => {
        delete t[key]
        saveTokens()
      })
    },
    machines: () => machines,
    dispose() {
      disposed = true
      if (stopTimer) clearTimeout(stopTimer)
      if (restartTimer) clearTimeout(restartTimer)
      stop()
      file.close()
    },
  }
}
