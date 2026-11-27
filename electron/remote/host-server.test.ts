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
