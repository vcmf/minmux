// The remote-host server (docs/design/REMOTE_CONTROL.md): the phone's web app and its WebSocket
// on this machine's Tailscale addresses only, every connection checked with `tailscale whois`,
// devices decided by main (it holds no authority). Run by the remote-host worker; tests start it
// on loopback with a fake CLI.

import fs from "node:fs"
import http from "node:http"
import type net from "node:net"
import path from "node:path"
import zlib from "node:zlib"
import { WebSocketServer, type WebSocket } from "ws"
import {
  PROTOCOL_VERSION,
  TICK_MS,
  parseClientMessage,
  type HostMessage,
  type PendingState,
  type RemotePanes,
  type SessionState,
} from "../../src/lib/remote-protocol"
import {
  allowedHosts,
  hostAllowed,
  fromOwnPage,
  sameOrigin,
  tokenCookie,
  upgradeAllowed,
} from "./guards"
import type { ClientInfo, FromHost, HostConfig, RpcCall, RpcResult, ToHost } from "./host-messages"
import {
  cliCandidates,
  findCli,
  parseStatus,
  parseWhois,
  peerAllowed,
  openUrl,
  runCli,
  type PeerNode,
  type SelfNode,
} from "./tailscale"
import { LOCK_AFTER_MS } from "./devices"
import { FAILED } from "./host-client"

export interface HostServerDeps {
  post: (m: FromHost) => void
  findCli?: () => string | null
  run?: (cli: string, args: string[], timeoutMs?: number) => Promise<string>
}

const defaultFindCli = () =>
  findCli(cliCandidates(process.platform, process.env.PATH ?? "", process.env))

export function createHostServer(d: HostServerDeps) {
  const post = d.post
  const run = d.run ?? runCli
  // Cookies are scoped by host, not port: one name per port, so the installed app and a dev build
  // on the same machine keep their own tokens.
  const cookieName = () => `minmux_remote_${config?.port ?? 0}`
  const tokenSetCookie = (token: string) =>
    `${cookieName()}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${30 * 24 * 3600}`
  const RECHECK_MS = 30_000
  const WHOIS_TTL_MS = 60_000
  const PING_MS = TICK_MS
  const PONG_TIMEOUT_MS = 45_000
  const TOUCH_EVERY_MS = 60_000
  const RPC_TIMEOUT_MS = 10_000

  let config: HostConfig | null = null
  let cli: string | null = null
  let self: SelfNode | null = null
  let servers: http.Server[] = []
  let listeningKey = ""
  let hosts = new Set<string>()
  let panes: RemotePanes = { tabs: [], panes: [], stale: true }

  // ── RPC to main ───────────────────────────────────────────────────────────────────────────────
  let nextRpc = 1
  type Results = { [R in RpcResult as R["op"]]: R["result"] }
  const waiting = new Map<number, (r: unknown) => void>()
  function rpc<K extends RpcCall["op"]>(call: Extract<RpcCall, { op: K }>): Promise<Results[K]> {
    const id = nextRpc++
    return new Promise<Results[K]>((resolve) => {
      // Main always answers; if it somehow doesn't, the safe "no" after a while (never a hang).
      const timer = setTimeout(() => {
        waiting.delete(id)
        resolve(FAILED[call.op].result as Results[K])
      }, RPC_TIMEOUT_MS)
      waiting.set(id, (r) => {
        clearTimeout(timer)
        resolve(r as Results[K])
      })
      post({ t: "rpc", id, call })
    })
  }

  // ── Peers ─────────────────────────────────────────────────────────────────────────────────────
  const whoisCache = new Map<string, { at: number; peer: PeerNode | null }>()
  async function peerOf(socket: net.Socket): Promise<PeerNode | null> {
    const addr = socket.remoteAddress
    if (!cli || !self || !addr) return null
    const ip = addr.startsWith("::ffff:") ? addr.slice(7) : addr
    const hit = whoisCache.get(ip)
    if (hit && Date.now() - hit.at < WHOIS_TTL_MS) return hit.peer
    let out: string
    try {
      out = await run(cli, ["whois", "--json", ip], 4000)
    } catch {
      // Not a tailnet address (Linux takes packets for 100.x on any interface), or tailscaled
      // was slow: refused now, never cached (a slow moment mustn't lock a phone out for a minute).
      return null
    }
    const peer = parseWhois(out)
    const ok = peer && self && peerAllowed(self, peer) ? peer : null
    whoisCache.set(ip, { at: Date.now(), peer: ok })
    return ok
  }

  // ── HTTP ──────────────────────────────────────────────────────────────────────────────────────
  // The phone page's policy. connect-src names the ws: origin too (older Safari doesn't count it
  // as 'self').
  const cspFor = (host: string) =>
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; " +
    `font-src 'self' data:; connect-src 'self' ws://${host}; object-src 'none'; base-uri 'none'; ` +
    "form-action 'self'; frame-ancestors 'none'"

  const TYPES: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".woff2": "font/woff2",
    ".woff": "font/woff",
    ".ttf": "font/ttf",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".json": "application/json",
  }

  function send(
    res: http.ServerResponse,
    status: number,
    body: string | Buffer,
    type = "text/plain; charset=utf-8",
    extra: Record<string, string> = {},
  ) {
    // Only one of our own names goes into the policy (a wrong-host answer gets none).
    const h = String(res.req.headers.host ?? "")
    const host = hosts.has(h.toLowerCase()) ? h : "invalid"
    res.writeHead(status, {
      "Content-Type": type,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      ...(config?.devUrl ? {} : { "Content-Security-Policy": cspFor(host) }),
      ...extra,
    })
    res.end(body)
  }
  const json = (
    res: http.ServerResponse,
    status: number,
    v: unknown,
    extra: Record<string, string> = {},
  ) => send(res, status, JSON.stringify(v), "application/json", extra)

  // Built files never change while the worker runs: read (and gzip) each once.
  const files = new Map<string, { raw: Buffer; gz: Buffer | null }>()
  const COMPRESSIBLE = new Set([".html", ".js", ".css", ".json", ".svg", ".ttf"])

  function serveStatic(req: http.IncomingMessage, res: http.ServerResponse, urlPath: string) {
    if (!config) return send(res, 503, "starting")
    const rel = urlPath === "/" || urlPath === "/index.html" ? "remote.html" : urlPath.slice(1)
    // Only the page and its built assets/fonts: nothing else in out/renderer.
    if (rel !== "remote.html" && !/^(assets|fonts)\/[\w.@-]+$/.test(rel))
      return send(res, 404, "not found")
    const file = path.join(config.staticDir, rel)
    const reply = (f: { raw: Buffer; gz: Buffer | null }) => {
      const headers: Record<string, string> = rel.startsWith("assets/")
        ? { "Cache-Control": "public, max-age=31536000, immutable" }
        : {}
      const gzip = f.gz && /\bgzip\b/.test(String(req.headers["accept-encoding"] ?? ""))
      if (gzip) headers["Content-Encoding"] = "gzip"
      headers.Vary = "Accept-Encoding"
      send(
        res,
        200,
        gzip ? f.gz! : f.raw,
        TYPES[path.extname(file)] ?? "application/octet-stream",
        headers,
      )
    }
    const hit = files.get(file)
    if (hit) return reply(hit)
    fs.readFile(file, (err, raw) => {
      if (err) return send(res, 404, "not found")
      const done = (gz: Buffer | null) => {
        const f = { raw, gz }
        files.set(file, f)
        reply(f)
      }
      if (!COMPRESSIBLE.has(path.extname(file)) || raw.length < 1024) return done(null)
      zlib.gzip(raw, { level: 9 }, (e, gz) => done(e ? null : gz))
    })
  }

  /** Dev builds: the web app comes from the Vite dev server (the phone can't reach localhost). */
  function proxyDev(req: http.IncomingMessage, res: http.ServerResponse, devUrl: string) {
    const raw = req.url ?? "/"
    if (!raw.startsWith("/")) return send(res, 400, "bad request") // only origin-form paths
    const u = new URL(raw, "http://x")
    const target = new URL((u.pathname === "/" ? "/remote.html" : u.pathname) + u.search, devUrl)
    const up = http.request(
      target,
      { method: "GET", headers: { accept: req.headers.accept ?? "*/*" } },
      (r) => {
        res.writeHead(r.statusCode ?? 502, {
          "Content-Type": r.headers["content-type"] ?? "text/plain",
          "Cache-Control": "no-store",
        })
        r.pipe(res)
      },
    )
    up.on("error", () =>
      res.headersSent ? res.destroy() : send(res, 502, "dev server not running"),
    )
    up.end()
  }

  function readBody(req: http.IncomingMessage, max = 4096): Promise<string | null> {
    return new Promise((resolve) => {
      let size = 0
      const parts: Buffer[] = []
      req.on("data", (c: Buffer) => {
        size += c.length
        if (size > max) {
          resolve(null)
          req.destroy()
        } else parts.push(c)
      })
      req.on("end", () => resolve(Buffer.concat(parts).toString("utf8")))
      req.on("error", () => resolve(null))
    })
  }

  async function onRequest(req: http.IncomingMessage, res: http.ServerResponse) {
    if (!self || !hostAllowed(req.headers, hosts)) return send(res, 421, "wrong host")
    const peer = await peerOf(req.socket)
    if (!peer) return send(res, 403, "This minmux only answers to its owner's devices.")
    const url = new URL(req.url ?? "/", "http://x")
    const p = url.pathname
    const machine = self.label

    if (req.method === "GET" && p === "/api/session") {
      if (!sameOrigin(req.headers)) return send(res, 403, "cross-site")
      const a = await rpc({
        op: "auth",
        token: tokenCookie(req.headers, cookieName()),
        nodeId: peer.nodeId,
      })
      const extra: Record<string, string> = {}
      if (a.state === "ok") {
        post({ t: "touch", deviceId: a.device.id }) // the page was opened: use
        // The cookie lives as long as the device: renewed on each use, not 30 days from approval.
        extra["Set-Cookie"] = tokenSetCookie(tokenCookie(req.headers, cookieName())!)
      }
      const body: SessionState =
        a.state === "ok"
          ? { state: "ok", machine, device: a.device.name }
          : a.state === "locked"
            ? { state: "locked", machine, device: a.device.name, pin: a.pin }
            : { state: "none", machine }
      return json(res, 200, body, extra)
    }
    if (req.method === "POST" && p === "/api/approve") {
      if (!fromOwnPage(req.headers)) return send(res, 403, "cross-site")
      const r = await rpc({ op: "approve", nodeId: peer.nodeId, name: peer.name })
      return json(res, 200, "id" in r ? { pending: r.id } : { error: r.error })
    }
    const pend = /^\/api\/pending\/([0-9a-f]{32})$/.exec(p)
    if (req.method === "GET" && pend) {
      if (!sameOrigin(req.headers)) return send(res, 403, "cross-site")
      const r = await rpc({ op: "pending", id: pend[1]!, nodeId: peer.nodeId })
      if (r.state === "approved") {
        const cookie = tokenSetCookie(r.token)
        return json(res, 200, { state: "approved" } satisfies PendingState, {
          "Set-Cookie": cookie,
        })
      }
      const body: PendingState =
        r.state === "pending" ? { state: "pending", code: r.code, machine } : r
      return json(res, 200, body)
    }
    if (req.method === "POST" && p === "/api/unlock") {
      if (!fromOwnPage(req.headers)) return send(res, 403, "cross-site")
      const raw = await readBody(req)
      let pin = ""
      try {
        pin = String((JSON.parse(raw ?? "{}") as { pin?: unknown }).pin ?? "")
      } catch {
        // empty
      }
      if (!/^\d{1,32}$/.test(pin)) return json(res, 400, { result: "wrong" })
      const result = await rpc({
        op: "unlock",
        token: tokenCookie(req.headers, cookieName()),
        nodeId: peer.nodeId,
        pin,
      })
      return json(res, 200, { result })
    }
    if (req.method === "GET" && p === "/hello")
      return json(res, 200, { minmux: true, v: PROTOCOL_VERSION, machine })
    if (req.method !== "GET") return send(res, 405, "method not allowed")
    if (config?.devUrl) return proxyDev(req, res, config.devUrl)
    return serveStatic(req, res, p)
  }

  // ── WebSocket ─────────────────────────────────────────────────────────────────────────────────
  interface Client {
    ws: WebSocket
    deviceId: string
    name: string
    nodeId: string
    token: string
    lastMsg: number
    lastTouch: number
    lastPong: number
    hello: boolean
  }
  const clients = new Set<Client>()
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: 64 * 1024,
    perMessageDeflate: true,
  })

  const sendTo = (c: Client, m: HostMessage) => {
    if (c.ws.readyState === c.ws.OPEN) c.ws.send(JSON.stringify(m))
  }

  function reportClients() {
    const seen = new Map<string, ClientInfo>()
    for (const c of clients)
      if (c.hello) seen.set(c.deviceId, { deviceId: c.deviceId, name: c.name })
    post({ t: "clients", clients: [...seen.values()] })
  }

  async function onUpgrade(req: http.IncomingMessage, socket: net.Socket, head: Buffer) {
    // Node drops its own error listener before 'upgrade': a reset during the awaits below
    // (whois, auth) would otherwise be an unhandled error that kills this worker.
    socket.on("error", () => socket.destroy())
    const refuse = (code: number) => {
      socket.end(`HTTP/1.1 ${code} ${http.STATUS_CODES[code]}\r\nConnection: close\r\n\r\n`)
    }
    if (!self || !hostAllowed(req.headers, hosts) || !upgradeAllowed(req.headers))
      return refuse(403)
    if (new URL(req.url ?? "/", "http://x").pathname !== "/ws") return refuse(404)
    const peer = await peerOf(socket)
    if (!peer) return refuse(403)
    const token = tokenCookie(req.headers, cookieName())
    const a = await rpc({ op: "auth", token, nodeId: peer.nodeId })
    if (a.state !== "ok") return refuse(401)
    wss.handleUpgrade(req, socket, head, (ws) => {
      const now = Date.now()
      const c: Client = {
        ws,
        deviceId: a.device.id,
        name: a.device.name,
        nodeId: peer.nodeId,
        token: token!,
        lastMsg: now,
        lastTouch: 0, // the first message (hello) counts as use
        lastPong: now,
        hello: false,
      }
      clients.add(c)
      ws.on("pong", () => (c.lastPong = Date.now()))
      ws.on("message", (data, isBinary) => void onMessage(c, isBinary ? null : data.toString()))
      ws.on("close", () => {
        clients.delete(c)
        reportClients()
      })
      ws.on("error", () => ws.terminate())
    })
  }

  async function onMessage(c: Client, raw: string | null) {
    const now = Date.now()
    // Idle for the lock's length while connected: main decides again (no PIN over a socket).
    if (now - c.lastMsg >= LOCK_AFTER_MS) {
      const a = await rpc({ op: "auth", token: c.token, nodeId: c.nodeId })
      if (a.state !== "ok") {
        sendTo(c, { t: "locked", reason: "idle" })
        c.ws.close(4001, "locked")
        return
      }
    }
    c.lastMsg = now
    if (now - c.lastTouch >= TOUCH_EVERY_MS) {
      c.lastTouch = now
      post({ t: "touch", deviceId: c.deviceId })
    }
    const m = parseClientMessage(raw)
    if (!m)
      return sendTo(c, { t: "error", code: "bad-message", message: "Unknown or malformed message" })
    if (m.t === "seen") return // counted above (lastMsg, touch)
    if (m.t === "hello") {
      if (m.v !== PROTOCOL_VERSION) {
        sendTo(c, { t: "bye", reason: "version" })
        c.ws.close(4002, "version")
        return
      }
      const a = await rpc({ op: "auth", token: c.token, nodeId: c.nodeId })
      if (a.state !== "ok") {
        sendTo(c, { t: "locked", reason: "idle" })
        c.ws.close(4001, "locked")
        return
      }
      c.hello = true
      sendTo(c, {
        t: "welcome",
        v: PROTOCOL_VERSION,
        machine: self?.label ?? "",
        device: a.device.name,
        permission: a.device.permission,
      })
      sendTo(c, { t: "panes", panes })
      reportClients()
    }
  }

  let recheckAt = 0
  const pingTimer = setInterval(() => {
    const now = Date.now()
    // A device that got locked, expired or removed while connected is dropped (once a minute).
    const recheck = now - recheckAt >= TOUCH_EVERY_MS
    if (recheck) recheckAt = now
    for (const c of clients) {
      if (now - c.lastPong > PONG_TIMEOUT_MS) c.ws.terminate()
      else {
        c.ws.ping()
        if (c.hello) sendTo(c, { t: "tick" })
        if (recheck && c.hello) void stillAllowed(c)
      }
    }
  }, PING_MS).unref()

  async function stillAllowed(c: Client) {
    const a = await rpc({ op: "auth", token: c.token, nodeId: c.nodeId })
    if (a.state === "ok" || c.ws.readyState !== c.ws.OPEN) return
    if (a.state === "locked") sendTo(c, { t: "locked", reason: "idle" })
    else sendTo(c, { t: "bye", reason: "revoked" })
    c.ws.close(4001, a.state)
  }

  // ── Listening ─────────────────────────────────────────────────────────────────────────────────
  function closeServers() {
    for (const s of servers) s.close()
    servers = []
    listeningKey = ""
  }

  // One refresh at a time: an overlapping one could bind the port twice.
  let refreshing: Promise<void> | null = null
  let portRetries = 0
  function refresh(): Promise<void> {
    refreshing ??= doRefresh().finally(() => (refreshing = null))
    return refreshing
  }

  async function doRefresh() {
    if (!config) return
    cli ??= (d.findCli ?? defaultFindCli)()
    if (!cli) return fail("missing")
    let r
    try {
      r = parseStatus(await run(cli, ["status", "--json"]))
    } catch (e) {
      cli = null // moved or removed: look again next time
      // A slow or failed check while listening changes nothing: try again next time.
      if (listeningKey) return
      return fail("error", String((e as Error).message ?? e))
    }
    if (!r.ok && r.reason === "error" && listeningKey) return
    if (!r.ok) return fail(r.reason, r.detail)
    if (r.self.tagged) return fail("tagged")
    // Another account or node: nobody connected or cached under the old identity stays.
    if (self && (self.userId !== r.self.userId || self.nodeId !== r.self.nodeId)) {
      whoisCache.clear()
      for (const c of clients) c.ws.terminate()
    }
    self = r.self
    const { port } = config
    hosts = allowedHosts([self.dnsName, self.shortName], self.ips, port)
    const key = `${self.ips.join(",")}:${port}`
    if (key === listeningKey) return
    closeServers()
    // Each address on its own: one that can't be bound (IPv6 off) doesn't stop the others, and
    // every server that did bind is kept or closed, never leaked.
    const settled = await Promise.allSettled(self.ips.map((ip) => listen(ip, port)))
    const bound = settled.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []))
    const errs = settled.flatMap((r) =>
      r.status === "rejected" ? [(r.reason as NodeJS.ErrnoException).code ?? "error"] : [],
    )
    const inUse = errs.includes("EADDRINUSE")
    servers = bound
    if (inUse || bound.length === 0) {
      closeServers()
      const code = inUse ? "EADDRINUSE" : errs[0]
      // A worker being replaced may still hold the port for a moment: try again soon.
      if (code === "EADDRINUSE" && portRetries < 10) {
        portRetries++
        setTimeout(() => void refresh(), 500)
        return
      }
      return fail(code === "EADDRINUSE" ? "port" : "error", code)
    }
    portRetries = 0
    listeningKey = key
    post({
      t: "status",
      status: {
        state: "listening",
        url: openUrl(self, port),
        machine: self.label,
        addresses: self.ips,
      },
    })
  }

  function listen(ip: string, port: number): Promise<http.Server> {
    return new Promise((resolve, reject) => {
      const s = http.createServer((req, res) => {
        onRequest(req, res).catch(() => {
          if (!res.headersSent) send(res, 500, "error")
          else res.end()
        })
      })
      s.headersTimeout = 10_000
      s.requestTimeout = 15_000
      s.on(
        "upgrade",
        (req, socket, head) =>
          void onUpgrade(req, socket as net.Socket, head).catch(() => socket.destroy()),
      )
      s.once("error", reject)
      s.listen(port, ip, () => {
        s.off("error", reject)
        resolve(s)
      })
    })
  }

  // Stopped or failed: no cached whois answer survives (the next tailnet may differ).
  function fail(
    reason: Extract<import("./host-messages").HostStatus, { state: "error" }>["reason"],
    detail?: string,
  ) {
    whoisCache.clear()
    closeServers()
    self = null
    for (const c of clients) c.ws.terminate()
    post({ t: "status", status: { state: "error", reason, detail } })
  }

  function handle(m: ToHost) {
    switch (m.t) {
      case "config":
        config = m.config
        post({ t: "status", status: { state: "starting" } })
        void refresh()
        break
      case "panes":
        panes = m.panes
        for (const c of clients) if (c.hello) sendTo(c, { t: "panes", panes })
        break
      case "rpc":
        waiting.get(m.id)?.(m.result.result)
        waiting.delete(m.id)
        break
      case "drop":
        for (const c of clients) {
          if (m.deviceId && c.deviceId !== m.deviceId) continue
          sendTo(
            c,
            m.reason === "locked"
              ? { t: "locked", reason: "idle" }
              : { t: "bye", reason: m.reason },
          )
          c.ws.close(4000, m.reason)
        }
        break
    }
  }

  const refreshTimer = setInterval(() => void refresh(), RECHECK_MS)
  refreshTimer.unref()

  /** Stops everything (tests; the worker just exits). */
  function stop() {
    clearInterval(pingTimer)
    clearInterval(refreshTimer)
    for (const c of clients) c.ws.terminate()
    closeServers()
    wss.close()
  }

  return { handle, stop, refresh }
}
