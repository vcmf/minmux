// @vitest-environment node
// End to end in one process: main's RemoteHost + DeviceTable talking to the real server, on
// loopback, with a fake `tailscale` CLI.
import fs from "node:fs"
import http from "node:http"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import zlib from "node:zlib"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import WebSocket from "ws"
import { DeviceTable } from "./devices"
import { RemoteHost, type Decision, type HostProc } from "./host-client"
import type { FromHost, ToHost } from "./host-messages"
import { createHostServer } from "./host-server"

const ME = "77"
const freePort = () =>
  new Promise<number>((resolve) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const p = (s.address() as net.AddressInfo).port
      s.close(() => resolve(p))
    })
  })

function fakeCli(user = { id: ME }) {
  return async (_cli: string, args: string[]) => {
    if (args[0] === "status")
      return JSON.stringify({
        BackendState: "Running",
        Self: { ID: "self", UserID: ME, DNSName: "mac.tail.ts.net.", TailscaleIPs: ["127.0.0.1"] },
      })
    return JSON.stringify({
      Node: { ID: "phone-node", Name: "iphone-15.tail.ts.net." },
      UserProfile: { ID: user.id },
    })
  }
}

interface Reply {
  status: number
  headers: http.IncomingHttpHeaders
  body: string
}
function request(
  port: number,
  p: string,
  o: { method?: string; headers?: Record<string, string>; body?: string; raw?: boolean } = {},
): Promise<Reply & { buf: Buffer }> {
  return new Promise((resolve, reject) => {
    const r = http.request(
      {
        host: "127.0.0.1",
        port,
        path: p,
        method: o.method ?? "GET",
        headers: { Host: `mac:${port}`, ...o.headers },
      },
      (res) => {
        const parts: Buffer[] = []
        res.on("data", (c: Buffer) => parts.push(c))
        res.on("end", () => {
          const buf = Buffer.concat(parts)
          resolve({ status: res.statusCode!, headers: res.headers, body: buf.toString(), buf })
        })
      },
    )
    r.on("error", reject)
    if (o.body) r.write(o.body)
    r.end()
  })
}

const until = async (f: () => boolean, ms = 3000) => {
  const end = Date.now() + ms
  while (!f()) {
    if (Date.now() > end) throw new Error("timed out")
    await new Promise((r) => setTimeout(r, 10))
  }
}

describe("remote host server", () => {
  let port: number
  let dir: string
  let host: RemoteHost
  let table: DeviceTable
  let statuses: FromHost[]
  let answer: Decision
  let cli: ReturnType<typeof fakeCli>
  let stops: (() => void)[]
  let sent: { deviceId: string; pane: string; text: string; id: string }[]
  let snaps: string[] // panes main was asked a snapshot of
  let untapped: string[]
  let keys: string[]

  beforeEach(async () => {
    port = await freePort()
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "remote-static-"))
    fs.writeFileSync(path.join(dir, "remote.html"), "<!doctype html><title>minmux</title>")
    fs.mkdirSync(path.join(dir, "assets"))
    fs.writeFileSync(path.join(dir, "assets", "app.js"), "console.log(1);".repeat(200))
    table = new DeviceTable(null, { save: () => {}, derive: async (p, s) => `${s}${p}` })
    statuses = []
    answer = "allow"
    cli = fakeCli()
    stops = []
    sent = []
    snaps = []
    untapped = []
    keys = []
    host = new RemoteHost({
      fork: () => {
        const handlers: { message: ((m: FromHost) => void)[]; exit: (() => void)[] } = {
          message: [],
          exit: [],
        }
        const server = createHostServer({
          post: (m) => {
            statuses.push(m)
            handlers.message.forEach((f) => f(m))
          },
          findCli: () => "tailscale",
          run: (c, a) => cli(c, a),
          timing: { ping: 40, recheck: 60, touch: 80, chatPoll: 50, feedIdle: 50 },
        })
        stops.push(server.stop)
        const proc: HostProc = {
          postMessage: (m: ToHost) => server.handle(m),
          on: (ev: "message" | "exit", fn: (x: never) => void) =>
            void (handlers[ev] as ((x: never) => void)[]).push(fn),
          kill: () => (server.stop(), true),
        }
        return proc
      },
      devices: async () => table,
      ask: async () => answer,
      onChange: () => {},
      snapshot: (pane) => {
        snaps.push(pane)
        if (pane === "gone") return null
        if (pane === "busy" && snaps.filter((p) => p === "busy").length === 1)
          throw new Error("main busy") // the first answer fails: retried, not "gone"
        return { epoch: 1, offset: 5, cols: 40, rows: 5, text: "hello" }
      },
      untap: (pane) => void untapped.push(pane),
      keys: async (_d, pane, data) => (keys.push(`${pane}:${JSON.stringify(data)}`), true),
      send: async (deviceId, pane, text, id) => {
        sent.push({ deviceId, pane, text, id })
        return { ok: true }
      },
    })
    host.apply({ port, staticDir: dir })
    await until(() => host.state.status.state === "listening")
  })

  afterEach(() => {
    host.dispose()
    stops.forEach((s) => s())
  })

  const origin = () => ({ Origin: `http://mac:${port}` })

  async function approve(): Promise<string> {
    const a = await request(port, "/api/approve", { method: "POST", headers: origin() })
    const { pending } = JSON.parse(a.body) as { pending: string }
    let r: Reply
    do r = await request(port, `/api/pending/${pending}`)
    while (JSON.parse(r.body).state === "pending")
    expect(JSON.parse(r.body).state).toBe("approved")
    return String(r.headers["set-cookie"]![0]!.split(";")[0])
  }

  it("listens and reports its address", () => {
    expect(host.state.status).toMatchObject({ state: "listening", url: `http://mac:${port}` })
  })

  it("refuses another Host, another user's device, and cross-site requests", async () => {
    expect((await request(port, "/hello", { headers: { Host: "evil.example" } })).status).toBe(421)
    expect((await request(port, "/api/approve", { method: "POST" })).status).toBe(403)
    expect(
      (await request(port, "/api/approve", { method: "POST", headers: { Origin: "http://evil" } }))
        .status,
    ).toBe(403)
    expect(
      (await request(port, "/api/session", { headers: { Origin: "https://evil.example" } })).status,
    ).toBe(403)
    expect((await request(port, "/hello")).status).toBe(200)
  })

  it("refuses a device of another user", async () => {
    host.dispose()
    stops.forEach((s) => s())
    cli = fakeCli({ id: "88" })
    host.apply({ port, staticDir: dir })
    await until(() => host.state.status.state === "listening")
    expect((await request(port, "/hello")).status).toBe(403)
  })

  it("serves only the page and its assets, gzipped, with a CSP", async () => {
    const page = await request(port, "/")
    expect(page.status).toBe(200)
    expect(page.headers["content-security-policy"]).toContain(`connect-src 'self' ws://mac:${port}`)
    const js = await request(port, "/assets/app.js", { headers: { "accept-encoding": "gzip" } })
    expect(js.headers["content-encoding"]).toBe("gzip")
    expect(zlib.gunzipSync(js.buf).toString()).toContain("console.log")
    expect((await request(port, "/../secrets")).status).toBe(404)
    expect((await request(port, "/main.js")).status).toBe(404)
  })

  it("approves a device, then knows it (and renews its cookie)", async () => {
    expect(JSON.parse((await request(port, "/api/session")).body).state).toBe("none")
    const cookie = await approve()
    const s = await request(port, "/api/session", { headers: { Cookie: cookie } })
    expect(JSON.parse(s.body)).toMatchObject({ state: "ok", device: "iphone-15" })
    expect(s.headers["set-cookie"]![0]).toContain(cookie)
    expect(table.list()).toHaveLength(1)
  })

  it("a denied request gets no cookie", async () => {
    answer = "deny"
    const a = await request(port, "/api/approve", { method: "POST", headers: origin() })
    const { pending } = JSON.parse(a.body) as { pending: string }
    let r: Reply
    do r = await request(port, `/api/pending/${pending}`)
    while (JSON.parse(r.body).state === "pending")
    expect(JSON.parse(r.body).state).toBe("denied")
    expect(r.headers["set-cookie"]).toBeUndefined()
  })

  it("sockets: welcome and panes, updates, removal", async () => {
    const cookie = await approve()
    const bad = await new Promise((res) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
        headers: { Host: `mac:${port}`, Origin: "http://evil", Cookie: cookie },
      })
      ws.on("unexpected-response", (_q, r) => res(r.statusCode))
    })
    expect(bad).toBe(403)

    const got: { t: string; [k: string]: unknown }[] = []
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
      headers: { Host: `mac:${port}`, ...origin(), Cookie: cookie },
    })
    ws.on("message", (d) => got.push(JSON.parse(d.toString())))
    await new Promise((r) => ws.on("open", r))
    ws.send(JSON.stringify({ t: "hello", v: 1, client: "web" }))
    await until(() => got.some((m) => m.t === "panes"))
    expect(got[0]).toMatchObject({ t: "welcome", device: "iphone-15", permission: "send" })
    await until(() => host.wanted)

    host.setPanes({ tabs: [{ id: "t", title: "rts" }], panes: [], stale: false })
    await until(() => got.filter((m) => m.t === "panes").length === 2)

    ws.send("nonsense")
    await until(() => got.some((m) => m.t === "error"))

    table.revoke(table.list()[0]!.id)
    host.drop(table.list()[0]?.id, "revoked")
    await until(() => got.some((m) => m.t === "bye"))
    await until(() => !host.wanted)
  })

  it("unlocks a locked device with the PIN", async () => {
    await table.setPin("123456")
    const cookie = await approve()
    const d = (table as unknown as { devices: { lastSeen: number }[] }).devices[0]!
    d.lastSeen -= 25 * 3600_000
    const locked = await request(port, "/api/session", { headers: { Cookie: cookie } })
    expect(JSON.parse(locked.body)).toMatchObject({ state: "locked", pin: true })
    const pin = (p: string) =>
      request(port, "/api/unlock", {
        method: "POST",
        headers: { ...origin(), Cookie: cookie, "Content-Type": "application/json" },
        body: JSON.stringify({ pin: p }),
      })
    expect(JSON.parse((await pin("000000")).body).result).toBe("wrong")
    expect((await pin("abc")).status).toBe(400)
    expect(JSON.parse((await pin("123456")).body).result).toBe("ok")
    expect(
      JSON.parse((await request(port, "/api/session", { headers: { Cookie: cookie } })).body).state,
    ).toBe("ok")
  })

  async function socket(
    cookie: string | null,
    o: { host?: string; origin?: string; path?: string } = {},
  ) {
    const got: { t: string; [k: string]: unknown }[] = []
    const ws = new WebSocket(`ws://127.0.0.1:${port}${o.path ?? "/ws"}`, {
      headers: {
        Host: o.host ?? `mac:${port}`,
        Origin: o.origin ?? `http://mac:${port}`,
        ...(cookie ? { Cookie: cookie } : {}),
      },
    })
    ws.on("message", (d) => got.push(JSON.parse(d.toString())))
    const status = await new Promise<number | "open">((res) => {
      ws.on("unexpected-response", (_q, r) => res(r.statusCode!))
      ws.on("open", () => res("open"))
    })
    return { ws, got, status }
  }

  async function hello(cookie: string) {
    const s = await socket(cookie)
    s.ws.send(JSON.stringify({ t: "hello", v: 1, client: "web" }))
    await until(() => s.got.some((m) => m.t === "welcome"))
    return s
  }

  it("refuses sockets without a device, on another path or host", async () => {
    expect((await socket(null)).status).toBe(401)
    const cookie = await approve()
    expect((await socket(cookie, { path: "/other" })).status).toBe(404)
    expect((await socket(cookie, { host: "evil:1" })).status).toBe(403)
  })

  it("ticks, and drops a device removed or locked while connected", async () => {
    const cookie = await approve()
    const s = await hello(cookie)
    await until(() => s.got.some((m) => m.t === "tick"))
    s.ws.send(JSON.stringify({ t: "seen" }))
    table.revoke(table.list()[0]!.id) // no drop from main: the recheck notices
    await until(() => s.got.some((m) => m.t === "bye" && m.reason === "revoked"))

    const cookie2 = await approve()
    const s2 = await hello(cookie2)
    ;(table as unknown as { devices: { lastSeen: number }[] }).devices[0]!.lastSeen -= 25 * 3600_000
    await until(() => s2.got.some((m) => m.t === "locked"))
  })

  it("a wrong protocol version gets bye version", async () => {
    const cookie = await approve()
    const s = await socket(cookie)
    s.ws.send(JSON.stringify({ t: "hello", v: 99, client: "web" }))
    await until(() => s.got.some((m) => m.t === "bye" && m.reason === "version"))
  })

  it("drop: locked and disconnected", async () => {
    const cookie = await approve()
    const a = await hello(cookie)
    host.drop(undefined, "locked")
    await until(() => a.got.some((m) => m.t === "locked"))
    const b = await hello(cookie)
    host.drop(undefined, "disconnected")
    await until(() => b.got.some((m) => m.t === "bye" && m.reason === "disconnected"))
  })

  it("unlock needs our Origin", async () => {
    const r = await request(port, "/api/unlock", { method: "POST", body: '{"pin":"1"}' })
    expect(r.status).toBe(403)
    expect((await request(port, "/api/pending/zz")).status).toBe(404)
    expect((await request(port, "/hello", { method: "DELETE" })).status).toBe(405)
  })

  it("keeps listening through a failed status check; an account change drops clients", async () => {
    const cookie = await approve()
    const s = await hello(cookie)
    const good = cli
    cli = async () => {
      throw new Error("slow")
    }
    await new Promise((r) => setTimeout(r, 150))
    expect(host.state.status.state).toBe("listening")
    expect(s.ws.readyState).toBe(WebSocket.OPEN)
    cli = async (c, a) =>
      a[0] === "status"
        ? JSON.stringify({
            BackendState: "Running",
            Self: {
              ID: "other",
              UserID: "99",
              DNSName: "mac.tail.ts.net.",
              TailscaleIPs: ["127.0.0.1"],
            },
          })
        : good(c, a)
    await until(() => s.ws.readyState === WebSocket.CLOSED, 3000)
  })

  it.each([
    [{ BackendState: "NeedsLogin" }, "signed-out"],
    [
      {
        BackendState: "Running",
        Self: {
          ID: "s",
          UserID: ME,
          DNSName: "mac.t.",
          TailscaleIPs: ["127.0.0.1"],
          Tags: ["tag:x"],
        },
      },
      "tagged",
    ],
  ])("reports %j as %s", async (status, reason) => {
    host.dispose()
    stops.forEach((s) => s())
    const posts: FromHost[] = []
    const s = createHostServer({
      post: (m) => posts.push(m),
      findCli: () => "tailscale",
      run: async () => JSON.stringify(status),
    })
    s.handle({ t: "config", config: { port, staticDir: dir } })
    await until(() => posts.some((m) => m.t === "status" && m.status.state === "error"))
    expect(posts.at(-1)).toMatchObject({ status: { state: "error", reason } })
    s.stop()
  })

  it("dev builds proxy the page to the dev server, query kept", async () => {
    const seen: string[] = []
    const dev = http.createServer((req, res) => {
      seen.push(req.url!)
      res.writeHead(200, { "Content-Type": "text/html" })
      res.end("dev page")
    })
    const devPort = await new Promise<number>((r) =>
      dev.listen(0, "127.0.0.1", () => r((dev.address() as net.AddressInfo).port)),
    )
    host.apply({ port, staticDir: dir, devUrl: `http://127.0.0.1:${devPort}` })
    await until(() => host.state.status.state === "listening")
    const page = await request(port, "/?pending=abc")
    expect(page.body).toBe("dev page")
    expect(seen).toContain("/remote.html?pending=abc")
    dev.close()
    await new Promise((r) => setTimeout(r, 50))
    expect((await request(port, "/src/x.ts")).status).toBe(502)
  })

  it("chat: watch a pane's conversation, live updates, older items, no agent", async () => {
    const f = path.join(dir, "t.jsonl")
    const line = (i: number) =>
      JSON.stringify({ type: "user", uuid: `u${i}`, message: { content: `message ${i}` } }) + "\n"
    fs.writeFileSync(f, Array.from({ length: 60 }, (_, i) => line(i)).join(""))
    host.setPanes({
      tabs: [{ id: "t", title: "t" }],
      panes: [
        { id: "p1", tab: "t", title: "a", kind: "agent", status: "idle", started: true },
        { id: "p2", tab: "t", title: "b", kind: "shell", status: "idle", started: true },
      ],
      stale: false,
    })
    host.setLeads({ p1: { agent: "claude", sessionId: "s1", files: [f] } })
    const s = await hello(await approve())
    s.ws.send(JSON.stringify({ t: "watch", pane: "p1" }))
    await until(() => s.got.some((m) => m.t === "chat" && m.reset))
    const first = s.got.find((m) => m.t === "chat" && m.reset) as unknown as {
      items: { id: string }[]
      more: boolean
    }
    expect(first.items).toHaveLength(50)
    expect(first.more).toBe(true)

    s.ws.send(JSON.stringify({ t: "more", pane: "p1", before: first.items[0]!.id }))
    await until(() => s.got.some((m) => m.t === "chat" && m.older))
    expect((s.got.find((m) => m.older) as unknown as { items: unknown[] }).items).toHaveLength(10)

    fs.appendFileSync(f, line(60))
    host.nudge(["p1"])
    await until(() =>
      s.got.some(
        (m) =>
          m.t === "chat" && !m.reset && !m.older && (m.items as { id: string }[])[0]?.id === "u60",
      ),
    )

    s.ws.send(JSON.stringify({ t: "watch", pane: "p2" }))
    await until(() =>
      s.got.some((m) => m.t === "chat" && m.pane === "p2" && m.unavailable === "no-agent"),
    )
    s.ws.send(JSON.stringify({ t: "unwatch", pane: "p1" }))
    s.ws.send(JSON.stringify({ t: "watch", pane: "nope" })) // not listed: ignored
  })

  it("chat: a passing read error is retried, not latched", async () => {
    const f = path.join(dir, "gone.jsonl") // doesn't exist yet: reads find nothing
    host.setPanes({
      tabs: [{ id: "t", title: "t" }],
      panes: [{ id: "p1", tab: "t", title: "a", kind: "agent", status: "idle", started: true }],
      stale: false,
    })
    host.setLeads({ p1: { agent: "claude", sessionId: "s1", files: [f] } })
    const s = await hello(await approve())
    s.ws.send(JSON.stringify({ t: "watch", pane: "p1" }))
    await until(() => s.got.some((m) => m.t === "chat" && m.reset))
    fs.writeFileSync(
      f,
      JSON.stringify({ type: "user", uuid: "late", message: { content: "hi" } }) + "\n",
    )
    await until(() =>
      s.got.some((m) => m.t === "chat" && (m.items as { id: string }[])[0]?.id === "late"),
    )
  })

  it("chat: a new session in the pane replaces the conversation", async () => {
    const a = path.join(dir, "a.jsonl")
    const b = path.join(dir, "b.jsonl")
    fs.writeFileSync(
      a,
      JSON.stringify({ type: "user", uuid: "fromA", message: { content: "a" } }) + "\n",
    )
    fs.writeFileSync(
      b,
      JSON.stringify({ type: "user", uuid: "fromB", message: { content: "b" } }) + "\n",
    )
    host.setPanes({
      tabs: [{ id: "t", title: "t" }],
      panes: [{ id: "p1", tab: "t", title: "a", kind: "agent", status: "idle", started: true }],
      stale: false,
    })
    host.setLeads({ p1: { agent: "claude", sessionId: "A", files: [a] } })
    const s = await hello(await approve())
    s.ws.send(JSON.stringify({ t: "watch", pane: "p1" }))
    await until(() => s.got.some((m) => m.t === "chat" && m.reset))
    host.setLeads({ p1: { agent: "claude", sessionId: "B", files: [b] } })
    await until(() => s.got.filter((m) => m.t === "chat" && m.reset).length === 2)
    const last = s.got.filter((m) => m.t === "chat" && m.reset).at(-1) as unknown as {
      items: { id: string }[]
    }
    expect(last.items.map((i) => i.id)).toEqual(["fromB"])
  })

  it("chat: an ended session's conversation can be opened again later", async () => {
    const f = path.join(dir, "ended.jsonl")
    fs.writeFileSync(
      f,
      JSON.stringify({ type: "user", uuid: "kept", message: { content: "x" } }) + "\n",
    )
    host.setPanes({
      tabs: [{ id: "t", title: "t" }],
      panes: [{ id: "p1", tab: "t", title: "a", kind: "agent", status: "idle", started: true }],
      stale: false,
    })
    host.setLeads({ p1: { agent: "claude", sessionId: "s1", files: [f] } })
    const s = await hello(await approve())
    s.ws.send(JSON.stringify({ t: "watch", pane: "p1" }))
    await until(() => s.got.some((m) => m.t === "chat" && m.reset))
    host.setLeads({}) // the session ended
    s.ws.send(JSON.stringify({ t: "unwatch", pane: "p1" }))
    await new Promise((r) => setTimeout(r, 150)) // the idle feed closes
    s.got.length = 0
    s.ws.send(JSON.stringify({ t: "watch", pane: "p1" }))
    await until(() => s.got.some((m) => m.t === "chat" && m.reset))
    const again = s.got.find((m) => m.t === "chat" && m.reset) as unknown as {
      items: { id: string }[]
      unavailable?: string
    }
    expect(again.unavailable).toBeUndefined()
    expect(again.items.map((i) => i.id)).toEqual(["kept"])
    // Load earlier for an item no longer in the log: by its place.
    s.ws.send(JSON.stringify({ t: "more", pane: "p1", before: "gone", seq: 1 }))
    await until(() => s.got.some((m) => m.t === "chat" && m.older))
  })

  it("chat: a watch that comes before its pane is listed is answered once it is", async () => {
    const f = path.join(dir, "early.jsonl")
    fs.writeFileSync(
      f,
      JSON.stringify({ type: "user", uuid: "e1", message: { content: "x" } }) + "\n",
    )
    host.setPanes({ tabs: [], panes: [], stale: false }) // a fresh list: nothing yet
    host.setLeads({ p9: { agent: "claude", sessionId: "s", files: [f] } })
    const s = await hello(await approve())
    s.ws.send(JSON.stringify({ t: "watch", pane: "p9" }))
    await new Promise((r) => setTimeout(r, 100))
    expect(s.got.some((m) => m.t === "chat")).toBe(false)
    host.setPanes({
      tabs: [{ id: "t", title: "t" }],
      panes: [{ id: "p9", tab: "t", title: "a", kind: "agent", status: "idle", started: true }],
      stale: false,
    })
    await until(() => s.got.some((m) => m.t === "chat" && m.reset))
  })

  it("chat: the same session moving to another transcript (a worktree) follows it", async () => {
    const a = path.join(dir, "main.jsonl")
    const b = path.join(dir, "wt.jsonl")
    fs.writeFileSync(
      a,
      JSON.stringify({ type: "user", uuid: "inMain", message: { content: "a" } }) + "\n",
    )
    fs.writeFileSync(
      b,
      JSON.stringify({ type: "user", uuid: "inWorktree", message: { content: "b" } }) + "\n",
    )
    host.setPanes({
      tabs: [{ id: "t", title: "t" }],
      panes: [{ id: "p1", tab: "t", title: "a", kind: "agent", status: "idle", started: true }],
      stale: false,
    })
    host.setLeads({ p1: { agent: "claude", sessionId: "S", files: [a] } })
    const s = await hello(await approve())
    s.ws.send(JSON.stringify({ t: "watch", pane: "p1" }))
    await until(() => s.got.some((m) => m.t === "chat" && m.reset))
    host.setLeads({ p1: { agent: "claude", sessionId: "S", files: [b] } })
    await until(() =>
      s.got.some(
        (m) => m.t === "chat" && m.reset && (m.items as { id: string }[])[0]?.id === "inWorktree",
      ),
    )
  })

  it("terminal: snapshot, live output, gaps, resize, raw keys, the tap stopped", async () => {
    host.setPanes({
      tabs: [{ id: "t", title: "t" }],
      panes: [{ id: "p1", tab: "t", title: "a", kind: "shell", status: "idle", started: true }],
      stale: false,
    })
    const cookie = await approve()
    table.setPermission(table.list()[0]!.id, "keys")
    const s = await hello(cookie)
    s.ws.send(JSON.stringify({ t: "term", pane: "p1", on: true }))
    await until(() => s.got.some((m) => m.t === "tsnap"))
    expect(s.got.find((m) => m.t === "tsnap")).toMatchObject({ cols: 40, rows: 5 })
    expect(
      String((s.got.find((m) => m.t === "tsnap") as unknown as { data: string }).data),
    ).toContain("hello")
    expect(snaps).toEqual(["p1"])

    host.tap({ t: "tout", pane: "p1", epoch: 1, offset: 5, data: " world" })
    await until(() => s.got.some((m) => m.t === "tout" && m.data === " world"))
    host.tap({ t: "tout", pane: "p1", epoch: 1, offset: 999, data: "lost" }) // a gap
    await until(() => snaps.length === 2)
    await until(() => s.got.filter((m) => m.t === "tsnap").length === 2)
    host.tap({ t: "treset", pane: "p1" })
    await until(() => snaps.length === 3)
    host.tap({ t: "tsize", pane: "p1", cols: 60, rows: 8 })
    await until(() => s.got.some((m) => m.t === "tsize" && m.cols === 60))

    s.ws.send(JSON.stringify({ t: "keys", pane: "p1", data: "\u0003" }))
    await until(() => keys.length === 1)
    expect(keys[0]).toBe('p1:"\\u0003"')

    s.ws.send(JSON.stringify({ t: "term", pane: "p1", on: false }))
    await until(() => untapped.includes("p1"))
  })

  it("terminal: a snapshot that failed is retried, not reported gone", async () => {
    host.setPanes({
      tabs: [{ id: "t", title: "t" }],
      panes: [{ id: "busy", tab: "t", title: "a", kind: "shell", status: "idle", started: true }],
      stale: false,
    })
    const s = await hello(await approve())
    s.ws.send(JSON.stringify({ t: "term", pane: "busy", on: true }))
    await until(() => s.got.some((m) => m.t === "tsnap"), 4000)
    expect(s.got.some((m) => m.t === "tsnap" && m.gone)).toBe(false)
    expect(snaps.filter((p) => p === "busy")).toHaveLength(2)
  })

  it("terminal: a pane gone on the computer; keys refused without the permission", async () => {
    host.setPanes({
      tabs: [{ id: "t", title: "t" }],
      panes: [{ id: "gone", tab: "t", title: "a", kind: "shell", status: "idle", started: true }],
      stale: false,
    })
    const s = await hello(await approve())
    s.ws.send(JSON.stringify({ t: "term", pane: "gone", on: true }))
    await until(() => s.got.some((m) => m.t === "tsnap" && m.gone))
    s.ws.send(JSON.stringify({ t: "keys", pane: "gone", data: "x" }))
    await new Promise((r) => setTimeout(r, 100))
    expect(keys).toEqual([]) // "send" devices can't type raw keys
  })

  it("send: relayed to main and acked; view-only devices refused here", async () => {
    const cookie = await approve()
    const s = await hello(cookie)
    s.ws.send(JSON.stringify({ t: "send", pane: "p1", text: "hi", id: "m1" }))
    await until(() => s.got.some((m) => m.t === "ack"))
    expect(s.got.find((m) => m.t === "ack")).toEqual({ t: "ack", id: "m1", ok: true })
    expect(sent).toEqual([{ deviceId: table.list()[0]!.id, pane: "p1", text: "hi", id: "m1" }])

    table.setPermission(table.list()[0]!.id, "view")
    const v = await hello(cookie)
    v.ws.send(JSON.stringify({ t: "send", pane: "p1", text: "hi", id: "m2" }))
    await until(() => v.got.some((m) => m.t === "ack"))
    expect(v.got.find((m) => m.t === "ack")).toMatchObject({ ok: false, reason: "not-allowed" })
    expect(sent).toHaveLength(1)
  })

  it("reports a missing CLI", async () => {
    host.dispose()
    stops.forEach((s) => s())
    const posts: FromHost[] = []
    const s = createHostServer({ post: (m) => posts.push(m), findCli: () => null })
    s.handle({ t: "config", config: { port, staticDir: dir } })
    await until(() => posts.some((m) => m.t === "status" && m.status.state === "error"))
    expect(posts.at(-1)).toMatchObject({ status: { state: "error", reason: "missing" } })
    s.stop()
  })
})
