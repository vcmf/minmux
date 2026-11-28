// @vitest-environment node
// The remote-client worker's logic against fake requests and sockets (the real server runs in
// host-server.test.ts): states a machine goes through, and what surfaces are told.
import { afterEach, describe, expect, it } from "vitest"
import type { SocketLike } from "../../src/remote/connection"
import type { HostMessage, SessionState } from "../../src/lib/remote-protocol"
import { createPeerClient, type HttpReply } from "./peer-client"
import type { FromClient, MachineView } from "./client-messages"
import type { SelfResult, TailnetPeer } from "./tailscale"

class FakeSocket implements SocketLike {
  sent: unknown[] = []
  closed = false
  onopen: (() => void) | null = null
  onmessage: ((e: { data: unknown }) => void) | null = null
  onclose: (() => void) | null = null
  send(d: string) {
    this.sent.push(JSON.parse(d))
  }
  close() {
    this.closed = true
  }
  host(m: HostMessage) {
    this.onmessage?.({ data: JSON.stringify(m) })
  }
}

const SELF: SelfResult = {
  ok: true,
  self: {
    userId: "u",
    nodeId: "n",
    dnsName: "me.ts.net",
    shortName: "me",
    label: "me",
    ips: ["100.64.0.1"],
    tagged: false,
    certDomains: [],
  },
}
const LINUX: TailnetPeer = {
  dnsName: "linux.ts.net",
  label: "linux",
  host: "linux.ts.net",
  self: false,
}
const KEY = "linux.ts.net:7420"
const ok = (body: unknown, cookies: string[] = []): HttpReply => ({
  status: 200,
  body: JSON.stringify(body),
  cookies,
})
const until = async (f: () => boolean, ms = 2000) => {
  const end = Date.now() + ms
  while (!f()) {
    if (Date.now() > end) throw new Error("timed out")
    await new Promise((r) => setTimeout(r, 5))
  }
}

function setup(o: { session?: () => SessionState; peers?: TailnetPeer[]; hello?: boolean } = {}) {
  const got: FromClient[] = []
  const sockets: FakeSocket[] = []
  const opened = new Set<FakeSocket>()
  let peers = o.peers ?? [LINUX]
  let hello = o.hello ?? true
  let pending: unknown[] = []
  let approve: unknown = { pending: "p1" }
  let session = o.session ?? ((): SessionState => ({ state: "ok", machine: "linux", device: "me" }))
  let fail = false
  const c = createPeerClient({
    post: (m) => got.push(m),
    ports: [7420],
    ownPort: 7421,
    timing: { pendingPoll: 5, poll: 20 },
    tailnet: async () => {
      if (fail) throw new Error("no cli")
      return { self: SELF, peers }
    },
    get: async (url) => {
      if (url.endsWith("/hello")) {
        if (!hello) throw new Error("refused")
        return ok({ minmux: true, v: 1, machine: "linux" })
      }
      if (url.endsWith("/api/session")) return ok(session())
      if (url.includes("/api/pending/")) {
        const r = pending.shift() ?? { state: "expired" }
        return r === "throw"
          ? Promise.reject(new Error("x"))
          : ok(r, (r as { cookie?: string }).cookie ? [(r as { cookie: string }).cookie] : [])
      }
      return { status: 404, body: "", cookies: [] }
    },
    postJson: async () => ok(approve),
    socket: () => {
      const s = new FakeSocket()
      sockets.push(s)
      return s
    },
  })
  const machine = (): MachineView | undefined =>
    (got.filter((m) => m.t === "machines").at(-1) as Extract<FromClient, { t: "machines" }>)
      ?.machines[0]
  return {
    c,
    got,
    sockets,
    machine,
    notes: () => got.flatMap((m) => (m.t === "note" ? [m.text] : [])),
    setPeers: (p: TailnetPeer[]) => (peers = p),
    setHello: (h: boolean) => (hello = h),
    setPending: (p: unknown[]) => (pending = p),
    setApprove: (a: unknown) => (approve = a),
    setSession: (f: () => SessionState) => (session = f),
    setFail: (f: boolean) => (fail = f),
    /** A connected link: the socket opened and said welcome. */
    async welcome(permission: "view" | "send" | "keys" = "keys") {
      // The next socket not opened yet (a new link opens a new one).
      await until(() => sockets.some((x) => !opened.has(x)))
      const s = sockets.find((x) => !opened.has(x))!
      opened.add(s)
      s.onopen?.()
      s.host({ t: "welcome", v: 1, machine: "linux", device: "me", permission })
      return s
    },
  }
}

let stops: (() => void)[] = []
afterEach(() => {
  stops.forEach((s) => s())
  stops = []
})

describe("peer client", () => {
  it("asks for access: the code while pending, then the token and a link", async () => {
    const t = setup()
    stops.push(t.c.stop)
    t.c.handle({ t: "tokens", tokens: {} })
    t.c.handle({ t: "list", on: true })
    await until(() => t.machine()?.state === "new")
    t.setPending([
      { state: "pending", code: "AB12" },
      { state: "approved", cookie: "minmux_remote_7420=tok; HttpOnly" },
    ])
    t.c.handle({ t: "pair", key: KEY })
    await until(() => t.got.some((m) => m.t === "machines" && m.machines[0]?.code === "AB12"))
    await until(() => t.got.some((m) => m.t === "token" && m.token === "tok"))
    const s = await t.welcome("view")
    expect(s.sent[0]).toMatchObject({ t: "hello", client: "minmux" })
    await until(() => t.machine()?.state === "connected")
    s.host({ t: "panes", panes: { tabs: [], panes: [], stale: false } })
    await until(() => !!t.machine()?.panes)
    // View only: surfaces are told, and keys go nowhere.
    t.c.handle({ t: "open", sid: "s1", key: KEY, pane: "p1" })
    t.c.handle({ t: "keys", sid: "s1", data: "x" })
    expect(s.sent.some((m) => (m as { t: string }).t === "keys")).toBe(false)
    s.host({ t: "welcome", v: 1, machine: "linux", device: "me", permission: "view" })
    expect(t.notes().some((n) => /view only/.test(n))).toBe(true)
  })

  it("an ask that's refused, denied, expired, or fails is 'denied'", async () => {
    const t = setup()
    stops.push(t.c.stop)
    t.c.handle({ t: "list", on: true })
    await until(() => t.machine()?.state === "new")
    t.setApprove({ error: "limited" })
    t.c.handle({ t: "pair", key: KEY })
    await until(() => t.machine()?.state === "denied")
    t.setApprove({ pending: "p2" })
    t.setPending([{ state: "denied" }])
    t.c.handle({ t: "pair", key: KEY })
    await until(() => t.got.filter((m) => m.t === "machines").length > 4)
    expect(t.machine()?.state).toBe("denied")
    t.setPending([{ state: "approved" }]) // no cookie: nothing to keep
    t.c.handle({ t: "pair", key: KEY })
    await new Promise((r) => setTimeout(r, 30))
    expect(t.machine()?.state).toBe("denied")
    t.setPending(["throw"])
    t.c.handle({ t: "pair", key: KEY })
    await new Promise((r) => setTimeout(r, 30))
    expect(t.machine()?.state).toBe("denied")
    t.c.handle({ t: "pair", key: "unknown:1" }) // not listed: nothing
  })

  it("a saved token links at once; locked, version, disconnected and removed say why", async () => {
    const t = setup()
    stops.push(t.c.stop)
    t.c.handle({ t: "tokens", tokens: { [KEY]: "tok" } })
    t.c.handle({ t: "open", sid: "s1", key: KEY, pane: "p1" }) // restored before it's found
    const s = await t.welcome()
    await until(() => t.machine()?.state === "connected")
    await until(() => s.sent.some((m) => (m as { t: string }).t === "term"))
    // Output for its pane goes to its surface; another pane's doesn't.
    s.host({ t: "tsnap", pane: "p1", cols: 80, rows: 24, data: "x" })
    s.host({ t: "tsnap", pane: "p1", cols: 80, rows: 24, data: "", gone: true })
    s.host({ t: "tout", pane: "p2", data: "y" })
    expect(t.got.filter((m) => m.t === "snap")).toHaveLength(1)
    expect(t.notes()).toContain("that pane was closed")
    expect(t.got.some((m) => m.t === "out")).toBe(false)
    // Found by the list later: its real name replaces the placeholder.
    t.c.handle({ t: "list", on: true })
    await until(() => t.machine()?.label === "linux")

    t.setSession(() => ({ state: "locked", machine: "linux", device: "me", pin: false }))
    s.host({ t: "locked", reason: "idle" })
    await until(() => t.machine()?.state === "locked")
    expect(t.notes().some((n) => /locked/.test(n))).toBe(true)

    // Approved again (new tokens): a fresh link, then the other ends of a link.
    t.setSession(() => ({ state: "ok", machine: "linux", device: "me" }))
    t.c.handle({ t: "tokens", tokens: { [KEY]: "tok2" } })
    let s2 = await t.welcome()
    await until(() => t.machine()?.state === "connected")
    s2.host({ t: "bye", reason: "version" })
    await until(() => t.notes().some((n) => /version/.test(n)))
    t.c.handle({ t: "tokens", tokens: { [KEY]: "tok3" } })
    s2 = await t.welcome()
    await until(() => t.machine()?.state === "connected")
    s2.host({ t: "bye", reason: "disconnected" })
    await until(() => t.notes().some((n) => /disconnected/.test(n)))
    t.c.handle({ t: "tokens", tokens: { [KEY]: "tok4" } })
    s2 = await t.welcome()
    await until(() => t.machine()?.state === "connected")
    s2.host({ t: "bye", reason: "revoked" })
    await until(() => t.got.some((m) => m.t === "token" && m.token === null))
    expect(t.machine()?.state).toBe("new")
  })

  it("an approved machine with no surface and no list unlinks; a lost one goes offline", async () => {
    const t = setup()
    stops.push(t.c.stop)
    t.c.handle({ t: "tokens", tokens: { [KEY]: "tok" } })
    t.c.handle({ t: "list", on: true })
    const s = await t.welcome()
    await until(() => t.machine()?.state === "connected")
    t.c.handle({ t: "list", on: false })
    expect(s.closed).toBe(true)
    expect(t.machine()?.state).toBe("offline")
    // A surface keeps it: gone from the tailnet, it stays listed (offline) while shown.
    t.c.handle({ t: "open", sid: "s1", key: KEY, pane: "p1" })
    await t.welcome()
    t.c.handle({ t: "seen" })
    t.c.handle({ t: "close", sid: "nope" })
    t.setPeers([])
    t.c.handle({ t: "list", on: true })
    await new Promise((r) => setTimeout(r, 50))
    expect(t.c.machines().map((m) => m.key)).toEqual([KEY])
    // Its surface closed and the list hidden: unlinked, then dropped at the next look.
    t.c.handle({ t: "close", sid: "s1" })
    t.c.handle({ t: "list", on: false })
    t.c.handle({ t: "list", on: true })
    await until(() => t.c.machines().length === 0, 3000)
  })

  it("no tailnet, or a peer that doesn't answer: nothing listed", async () => {
    const t = setup({ hello: false })
    stops.push(t.c.stop)
    t.c.handle({ t: "list", on: true })
    await new Promise((r) => setTimeout(r, 40))
    expect(t.c.machines()).toEqual([])
    t.setFail(true)
    t.setHello(true)
    await new Promise((r) => setTimeout(r, 40))
    expect(t.c.machines()).toEqual([])
    t.c.handle({ t: "forget", key: KEY }) // unknown: nothing
    t.c.handle({ t: "refresh", sid: "nope" })
  })

  it("disconnected by that computer: held until Connect (or opening a pane)", async () => {
    const t = setup()
    stops.push(t.c.stop)
    t.c.handle({ t: "tokens", tokens: { [KEY]: "tok" } })
    t.c.handle({ t: "list", on: true })
    const s = await t.welcome("view")
    await until(() => t.machine()?.state === "connected")
    s.host({ t: "welcome", v: 1, machine: "linux", device: "me", permission: "view" })
    t.c.handle({ t: "open", sid: "s1", key: KEY, pane: "p1" }) // told it's view only
    expect(t.notes().filter((n) => /view only/.test(n))).toHaveLength(1)
    s.host({ t: "bye", reason: "disconnected" })
    await until(() => t.machine()?.state === "held")
    expect(s.closed).toBe(true)
    const n = t.sockets.length
    await new Promise((r) => setTimeout(r, 60)) // polls: no reconnect by itself
    expect(t.sockets.length).toBe(n)
    t.c.handle({ t: "connect", key: KEY })
    await t.welcome()
    await until(() => t.machine()?.state === "connected")
    t.c.handle({ t: "connect", key: KEY }) // not held: nothing
    // Held again, then a pane opened: that's asking to connect too.
    t.sockets.at(-1)!.host({ t: "bye", reason: "version" })
    await until(() => t.machine()?.state === "held")
    t.c.handle({ t: "open", sid: "s2", key: KEY, pane: "p1" })
    await t.welcome()
    await until(() => t.machine()?.state === "connected")
  })

  it("drive: sent while linked (keys only), asked again on a new link, released on close", async () => {
    const t = setup()
    stops.push(t.c.stop)
    t.c.handle({ t: "tokens", tokens: { [KEY]: "tok" } })
    t.c.handle({ t: "open", sid: "s1", key: KEY, pane: "p1" })
    const s = await t.welcome("keys")
    await until(() => t.machine()?.state === "connected")
    t.c.handle({ t: "drive", sid: "s1", cols: 90, rows: 30 })
    expect(s.sent).toContainEqual({ t: "drive", pane: "p1", cols: 90, rows: 30 })
    t.c.handle({ t: "drive", sid: "nope", cols: 90, rows: 30 })
    s.onclose?.() // the link drops: a new one asks for the size again
    const s2 = await t.welcome("keys")
    await until(() => s2.sent.some((m) => (m as { t: string }).t === "drive"))
    t.c.handle({ t: "close", sid: "s1" })
    expect(s2.sent).toContainEqual({ t: "release", pane: "p1" })
  })

  it("this minmux's own port, once main says it, is never listed", async () => {
    const t = setup({ peers: [{ ...LINUX, self: true, label: "me" }] })
    stops.push(t.c.stop)
    t.c.handle({ t: "list", on: true })
    await until(() => t.machine()?.label === "me (this computer)")
    t.c.handle({ t: "port", own: 7420 })
    expect(t.c.machines()).toEqual([])
  })

  it("an unapproved machine's restored surface says so", async () => {
    const t = setup()
    stops.push(t.c.stop)
    t.c.handle({ t: "tokens", tokens: {} })
    t.c.handle({ t: "open", sid: "s1", key: KEY, pane: "p1" })
    expect(t.notes()).toContain("this machine isn't approved there")
  })
})
