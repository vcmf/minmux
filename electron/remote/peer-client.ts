// The remote-client worker's logic (docs/design/REMOTE_CONTROL.md, "minmux on another machine"):
// finds the user's other minmux on the tailnet (each machine's `/hello`), asks one for access
// the way a phone does (its window shows a prompt with a code), and keeps one link per approved
// machine while the sidebar lists machines or a surface shows one of its panes. A remote pane's
// terminal comes in as a clean screen and then output, relayed to main by surface id.

import http from "node:http"
import WebSocket from "ws"
import { Link, type LinkState, type SocketLike } from "../../src/remote/connection"
import {
  PROTOCOL_VERSION,
  SEEN_EVERY_MS,
  type HostMessage,
  type PendingState,
  type Permission,
  type RemotePanes,
  type SessionState,
} from "../../src/lib/remote-protocol"
import type { FromClient, MachineState, MachineView, ToClient } from "./client-messages"
import type { SelfResult, TailnetPeer } from "./tailscale"

/** A machine's address and name, as found. */
export interface Found {
  key: string // "<host>:<port>"
  label: string
  url: string // "http://<host>:<port>"
  port: number
}

export interface PeerClientDeps {
  post: (m: FromClient) => void
  /** This machine and the tailnet's machines that may run a minmux (`tailscale status`). */
  tailnet: () => Promise<{ self: SelfResult; peers: TailnetPeer[] }>
  ports: number[] // where a minmux listens (release, dev, …)
  ownPort: number // this minmux's own (never listed)
  timing?: { poll?: number; probe?: number; pendingPoll?: number }
  /** For tests: requests and sockets. */
  get?: (url: string, headers: Record<string, string>) => Promise<HttpReply>
  postJson?: (url: string, headers: Record<string, string>, body: string) => Promise<HttpReply>
  socket?: (url: string, headers: Record<string, string>) => SocketLike
  now?: () => number
}

export interface HttpReply {
  status: number
  body: string
  cookies: string[]
}

const DEV_PORT = 7421
const VIEW_ONLY = "view only: that computer's Settings can let this machine type"

function request(
  method: "GET" | "POST",
  url: string,
  headers: Record<string, string>,
  body: string | null,
  timeoutMs: number,
): Promise<HttpReply> {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method, headers, timeout: timeoutMs }, (res) => {
      const parts: Buffer[] = []
      let size = 0
      res.on("data", (c: Buffer) => {
        size += c.length
        if (size > 64 * 1024) req.destroy(new Error("too large"))
        else parts.push(c)
      })
      res.on("end", () =>
        resolve({
          status: res.statusCode ?? 0,
          body: Buffer.concat(parts).toString("utf8"),
          cookies: res.headers["set-cookie"] ?? [],
        }),
      )
      res.on("error", reject)
    })
    req.on("timeout", () => req.destroy(new Error("timeout")))
    req.on("error", reject)
    req.end(body ?? undefined)
  })
}

/** The machines a minmux answers on: each peer × port that says `/hello`, never our own port. */
export function candidates(peers: TailnetPeer[], ports: number[], ownPort: number): Found[] {
  const out: Found[] = []
  for (const p of peers)
    for (const port of ports) {
      if (p.self && port === ownPort) continue
      const name = p.self ? `${p.label} (this computer)` : p.label
      out.push({
        key: `${p.host}:${port}`,
        label: port === DEV_PORT ? `${name} · dev` : name,
        url: `http://${p.host}:${port}`,
        port,
      })
    }
  return out
}

const cookieName = (port: number) => `minmux_remote_${port}`

/** The token a Set-Cookie hands out for this port's cookie, if any. */
export function tokenFrom(cookies: string[], port: number): string | null {
  const name = cookieName(port)
  for (const c of cookies) {
    const [kv] = c.split(";")
    const [k, ...v] = (kv ?? "").trim().split("=")
    if (k === name && v.join("=")) return v.join("=")
  }
  return null
}

interface Machine {
  found: Found
  state: MachineState
  code?: string
  token?: string
  link?: Link
  open: boolean // the link is up (welcome)
  permission?: Permission
  panes?: RemotePanes
  pairing?: boolean
}

interface Surface {
  key: string
  pane: string
  drive?: { cols: number; rows: number } // the size it last asked for (asked again on a new link)
}

export function createPeerClient(d: PeerClientDeps) {
  const POLL_MS = d.timing?.poll ?? 30_000
  const PROBE_MS = d.timing?.probe ?? 2500
  const PENDING_POLL_MS = d.timing?.pendingPoll ?? 1000
  const now = d.now ?? Date.now
  const get = d.get ?? ((url, headers) => request("GET", url, headers, null, PROBE_MS))
  const postJson =
    d.postJson ?? ((url, headers, body) => request("POST", url, headers, body, PROBE_MS))
  const socket =
    d.socket ??
    ((url, headers) => {
      const ws = new WebSocket(url, { headers, perMessageDeflate: true, maxPayload: 8 << 20 })
      ws.on("error", () => {}) // a refused or dropped socket: its close follows (Link retries)
      return ws as unknown as SocketLike
    })

  const machines = new Map<string, Machine>()
  let ownPort = d.ownPort
  const surfaces = new Map<string, Surface>()
  let tokens: Record<string, string> = {}
  let listing = false
  let pollTimer: ReturnType<typeof setTimeout> | null = null
  let lastSeen = 0
  let finding: Promise<void> | null = null

  const headersFor = (m: Machine): Record<string, string> => ({
    Origin: m.found.url,
    ...(m.token ? { Cookie: `${cookieName(m.found.port)}=${m.token}` } : {}),
  })

  function report() {
    const list: MachineView[] = [...machines.values()]
      .sort((a, b) => a.found.label.localeCompare(b.found.label))
      .map((m) => ({
        key: m.found.key,
        label: m.found.label,
        state: m.state,
        ...(m.code && m.state === "pairing" ? { code: m.code } : {}),
        ...(m.open && m.permission ? { permission: m.permission } : {}),
        ...(m.open && m.panes ? { panes: m.panes } : {}),
      }))
    d.post({ t: "machines", machines: list })
  }

  /** Is the link to this machine wanted: the list is shown, or a surface shows one of its panes. */
  const wanted = (m: Machine) =>
    !!m.token && (listing || [...surfaces.values()].some((s) => s.key === m.found.key))

  function sync(m: Machine) {
    if (m.state === "held") return // only by hand (Connect, or opening one of its panes)
    if (wanted(m) && !m.link) connect(m)
    else if (!wanted(m) && m.link) {
      m.link.stop()
      m.link = undefined
      m.open = false
      if (m.state === "connected" || m.state === "connecting") m.state = "offline"
    }
  }

  function connect(m: Machine) {
    m.state = "connecting"
    const link = new Link({
      client: "minmux",
      socket: () => socket(m.found.url.replace(/^http/, "ws") + "/ws", headersFor(m)),
      session: async () => {
        const r = await get(`${m.found.url}/api/session`, headersFor(m))
        if (r.status !== 200) throw new Error(`session ${r.status}`)
        return JSON.parse(r.body) as SessionState
      },
      onState: (s) => onLinkState(m, link, s),
      onMessage: (msg) => onHostMessage(m, msg),
      visible: () => now() - lastSeen < SEEN_EVERY_MS,
      now: d.now,
    })
    m.link = link
    link.start()
  }

  function onLinkState(m: Machine, link: Link, s: LinkState) {
    if (m.link !== link) return
    switch (s.state) {
      case "open":
        m.state = "connected"
        m.open = true
        // A fresh link: follow every pane a surface shows again (each starts with a clean screen).
        for (const pane of new Set(
          [...surfaces.values()].filter((x) => x.key === m.found.key).map((x) => x.pane),
        ))
          link.send({ t: "term", pane, on: true })
        break
      case "connecting":
      case "reconnecting":
        m.open = false
        m.state = "connecting"
        if (s.state === "reconnecting" && s.unreachable) m.state = "offline"
        break
      case "locked":
        m.open = false
        m.state = "locked"
        note(m, "access locked (unused for a while): ask again from the sidebar")
        break
      case "no-access":
      case "removed":
        m.open = false
        m.state = "new"
        forgetToken(m)
        note(m, "access removed on that computer: ask again from the sidebar")
        break
      // Final for the link: dropped, so Connect (or opening a pane) can start a new one.
      case "version":
      case "disconnected":
        m.open = false
        m.state = "held"
        m.link = undefined
        link.stop()
        note(
          m,
          s.state === "version"
            ? "that minmux runs another version: update both"
            : "disconnected from that computer: Connect in the sidebar",
        )
        break
    }
    report()
  }

  function note(m: Machine, text: string) {
    for (const [sid, s] of surfaces) if (s.key === m.found.key) d.post({ t: "note", sid, text })
  }

  function forgetToken(m: Machine) {
    m.token = undefined
    m.link?.stop()
    m.link = undefined
    delete tokens[m.found.key]
    d.post({ t: "token", key: m.found.key, token: null })
  }

  function onHostMessage(m: Machine, msg: HostMessage) {
    switch (msg.t) {
      case "welcome": {
        // Said once per change (a reconnect says welcome again), and to each pane opened later.
        const was = m.permission
        m.permission = msg.permission
        if (msg.permission !== "keys" && was !== msg.permission) note(m, VIEW_ONLY)
        // A size asked for before the link (or the permission) was there: asked now.
        if (msg.permission === "keys")
          for (const s of surfaces.values())
            if (s.key === m.found.key && s.drive)
              m.link?.send({ t: "drive", pane: s.pane, ...s.drive })
        return report()
      }
      case "panes":
        m.panes = msg.panes
        return report()
      case "tsnap":
        for (const [sid, s] of surfaces)
          if (s.key === m.found.key && s.pane === msg.pane) {
            if (msg.gone) d.post({ t: "note", sid, text: "that pane was closed" })
            else d.post({ t: "snap", sid, cols: msg.cols, rows: msg.rows, data: msg.data })
          }
        return
      case "tout":
        for (const [sid, s] of surfaces)
          if (s.key === m.found.key && s.pane === msg.pane)
            d.post({ t: "out", sid, data: msg.data })
        return
      case "tsize":
        for (const [sid, s] of surfaces)
          if (s.key === m.found.key && s.pane === msg.pane)
            d.post({ t: "size", sid, cols: msg.cols, rows: msg.rows })
        return
    }
  }

  /** Probe each candidate's `/hello`; keep what answers (and what's linked or pairing). */
  async function find(): Promise<void> {
    let tn: Awaited<ReturnType<PeerClientDeps["tailnet"]>>
    try {
      tn = await d.tailnet()
    } catch {
      return
    }
    if (!tn.self.ok) return
    const found = candidates(tn.peers, d.ports, ownPort)
    const answers = await Promise.all(
      found.map(async (f) => {
        try {
          const r = await get(`${f.url}/hello`, { Origin: f.url })
          const o = JSON.parse(r.body) as { minmux?: unknown; v?: unknown }
          return r.status === 200 && o.minmux === true && o.v === PROTOCOL_VERSION
        } catch {
          return false
        }
      }),
    )
    const seen = new Set<string>()
    found.forEach((f, i) => {
      const m = machines.get(f.key)
      if (answers[i]) {
        seen.add(f.key)
        if (!m) {
          const token = tokens[f.key]
          machines.set(f.key, {
            found: f,
            state: token ? "connecting" : "new",
            token,
            open: false,
          })
        } else {
          m.found = f // its real name, once found (a restored surface's placeholder had a host)
          if (m.state === "offline" && !m.link) m.state = m.token ? "connecting" : "new"
        }
      }
    })
    for (const [key, m] of machines)
      if (!seen.has(key) && !m.open && !m.pairing) {
        // Gone: dropped unless a surface still shows one of its panes (its link keeps retrying).
        if ([...surfaces.values()].some((s) => s.key === key)) m.state = "offline"
        else {
          m.link?.stop()
          machines.delete(key)
        }
      }
    for (const m of machines.values()) sync(m)
    report()
  }

  function findSoon(): Promise<void> {
    finding ??= find().finally(() => (finding = null))
    return finding
  }

  function schedule() {
    if (pollTimer) clearTimeout(pollTimer)
    pollTimer = null
    if (!listing) return
    pollTimer = setTimeout(() => {
      void findSoon().then(schedule)
    }, POLL_MS)
  }

  async function pair(key: string) {
    const m = machines.get(key)
    if (!m || m.pairing) return
    m.pairing = true
    try {
      const r = await postJson(
        `${m.found.url}/api/approve`,
        { Origin: m.found.url, "Content-Type": "application/json" },
        JSON.stringify({ machine: true }),
      )
      const o = JSON.parse(r.body) as { pending?: string; error?: string }
      if (!o.pending) {
        m.state = "denied"
        return report()
      }
      for (;;) {
        const p = await get(`${m.found.url}/api/pending/${o.pending}`, { Origin: m.found.url })
        const s = JSON.parse(p.body) as PendingState
        if (s.state === "pending") {
          if (m.code !== s.code || m.state !== "pairing") {
            m.state = "pairing"
            m.code = s.code
            report()
          }
          await new Promise((res) => setTimeout(res, PENDING_POLL_MS))
          continue
        }
        if (s.state === "approved") {
          const token = tokenFrom(p.cookies, m.found.port)
          if (token) {
            m.token = token
            tokens[key] = token
            d.post({ t: "token", key, token })
            m.state = "connecting"
            m.link?.stop()
            m.link = undefined
            sync(m)
            return report()
          }
        }
        m.state = "denied"
        return report()
      }
    } catch {
      m.state = "denied"
      report()
    } finally {
      m.pairing = false
      m.code = undefined
    }
  }

  function handle(msg: ToClient) {
    switch (msg.t) {
      case "tokens":
        tokens = { ...msg.tokens }
        for (const m of machines.values()) {
          const t = tokens[m.found.key]
          if (t !== m.token) {
            m.link?.stop()
            m.link = undefined
            m.open = false
            m.token = t
            m.state = t ? "connecting" : "new"
          }
          sync(m)
        }
        return report()
      case "list":
        listing = msg.on
        if (listing) void findSoon().then(schedule)
        else schedule()
        for (const m of machines.values()) sync(m)
        return report()
      case "pair":
        return void pair(msg.key)
      case "connect": {
        const m = machines.get(msg.key)
        if (m?.state !== "held") return
        m.state = m.token ? "connecting" : "new"
        sync(m)
        return report()
      }
      case "port":
        ownPort = msg.own
        for (const [key, m] of machines)
          if (m.found.label.includes("(this computer)") && m.found.port === ownPort) {
            m.link?.stop()
            machines.delete(key)
          }
        return report()
      case "forget": {
        const m = machines.get(msg.key)
        if (m) forgetToken(m)
        if (m) m.state = "new"
        return report()
      }
      case "open": {
        surfaces.set(msg.sid, { key: msg.key, pane: msg.pane })
        let m = machines.get(msg.key)
        if (!m) {
          // A restored surface: its machine before the list has found it.
          const [host, port] = splitKey(msg.key)
          m = {
            found: { key: msg.key, label: host, url: `http://${msg.key}`, port },
            state: "connecting",
            token: tokens[msg.key],
            open: false,
          }
          machines.set(msg.key, m)
          void findSoon() // its real name
        }
        if (!m.token) d.post({ t: "note", sid: msg.sid, text: "this machine isn't approved there" })
        if (m.open && m.permission && m.permission !== "keys")
          d.post({ t: "note", sid: msg.sid, text: VIEW_ONLY })
        if (m.state === "held") m.state = m.token ? "connecting" : "new" // opening one is asking
        if (m.open) m.link?.send({ t: "term", pane: msg.pane, on: true })
        else sync(m)
        return report()
      }
      case "close": {
        const s = surfaces.get(msg.sid)
        surfaces.delete(msg.sid)
        if (!s) return
        const m = machines.get(s.key)
        if (!m) return
        const still = [...surfaces.values()].some((x) => x.key === s.key && x.pane === s.pane)
        if (!still && m.open) m.link?.send({ t: "term", pane: s.pane, on: false })
        if (!still && m.open && s.drive) m.link?.send({ t: "release", pane: s.pane })
        sync(m)
        return report()
      }
      case "refresh": {
        const s = surfaces.get(msg.sid)
        const m = s && machines.get(s.key)
        if (s && m?.open) m.link?.send({ t: "term", pane: s.pane, on: true })
        return
      }
      case "drive": {
        const s = surfaces.get(msg.sid)
        const m = s && machines.get(s.key)
        if (!s) return
        // The one in use: no other surface of that pane asks for its size on a reconnect.
        for (const x of surfaces.values())
          if (x.key === s.key && x.pane === s.pane) x.drive = undefined
        s.drive = { cols: msg.cols, rows: msg.rows }
        if (m?.open && m.permission === "keys")
          m.link?.send({ t: "drive", pane: s.pane, ...s.drive })
        return
      }
      case "undrive": {
        const s = surfaces.get(msg.sid)
        if (s) s.drive = undefined
        return
      }
      case "keys": {
        const s = surfaces.get(msg.sid)
        const m = s && machines.get(s.key)
        if (!s || !m?.open || m.permission !== "keys") return
        m.link?.send({ t: "keys", pane: s.pane, data: msg.data })
        return
      }
      case "seen":
        lastSeen = now()
        return
    }
  }

  return {
    handle,
    /** Tests: what the client knows. */
    machines: () => [...machines.values()].map((m) => ({ key: m.found.key, state: m.state })),
    stop: () => {
      if (pollTimer) clearTimeout(pollTimer)
      for (const m of machines.values()) m.link?.stop()
    },
  }
}

function splitKey(key: string): [string, number] {
  const i = key.lastIndexOf(":")
  return [key.slice(0, i), Number(key.slice(i + 1))]
}
