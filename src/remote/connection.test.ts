import { describe, expect, it } from "vitest"
import type { SessionState } from "../lib/remote-protocol"
import { backoffMs, Link, type LinkState, type SocketLike } from "./connection"

class FakeSocket implements SocketLike {
  sent: string[] = []
  closed = false
  onopen: (() => void) | null = null
  onmessage: ((e: { data: unknown }) => void) | null = null
  onclose: (() => void) | null = null
  send(d: string) {
    this.sent.push(d)
  }
  close() {
    this.closed = true
  }
  recv(m: unknown) {
    this.onmessage?.({ data: JSON.stringify(m) })
  }
}

function setup(sessions: (SessionState | Error)[]) {
  let t = 0
  const timers: { at: number; fn: () => void }[] = []
  const sockets: FakeSocket[] = []
  const states: LinkState[] = []
  const link = new Link({
    socket: () => {
      const s = new FakeSocket()
      sockets.push(s)
      return s
    },
    session: async () => {
      const s = sessions.length > 1 ? sessions.shift()! : sessions[0]!
      if (s instanceof Error) throw s
      return s
    },
    onState: (s) => states.push(s),
    onMessage: () => {},
    now: () => t,
    setTimer: (fn, ms) => {
      const e = { at: t + ms, fn }
      timers.push(e)
      return e
    },
    clearTimer: (e) => {
      const i = timers.indexOf(e as (typeof timers)[number])
      if (i >= 0) timers.splice(i, 1)
    },
  })
  const tick = async (ms: number) => {
    t += ms
    for (;;) {
      const due = timers.filter((e) => e.at <= t).sort((a, b) => a.at - b.at)[0]
      if (!due) break
      timers.splice(timers.indexOf(due), 1)
      due.fn()
      await flush()
    }
  }
  return { link, sockets, states, tick, last: () => states[states.length - 1]! }
}

const flush = () => new Promise((r) => setTimeout(r, 0))
const ok: SessionState = { state: "ok", machine: "mac", device: "iphone" }

describe("Link", () => {
  it("connects, says hello, and is open on welcome", async () => {
    const { link, sockets, last } = setup([ok])
    link.start()
    await flush()
    const ws = sockets[0]!
    ws.onopen!()
    expect(JSON.parse(ws.sent[0]!)).toMatchObject({ t: "hello", client: "web" })
    ws.recv({ t: "welcome", v: 1, machine: "mac", device: "iphone", permission: "send" })
    expect(last()).toEqual({ state: "open", machine: "mac", device: "iphone" })
  })

  it("reconnects with backoff after a drop, checking the session first", async () => {
    const { link, sockets, last, tick } = setup([ok, new Error("down"), ok])
    link.start()
    await flush()
    sockets[0]!.recv({ t: "welcome", v: 1, machine: "mac", device: "iphone", permission: "send" })
    sockets[0]!.onclose!()
    expect(last()).toMatchObject({ state: "reconnecting", attempt: 1, unreachable: false })
    await tick(backoffMs(1))
    expect(last()).toMatchObject({ state: "reconnecting", attempt: 2, unreachable: true })
    await tick(backoffMs(2))
    expect(sockets).toHaveLength(2)
  })

  it("treats 35 s without a tick as dead", async () => {
    const { link, sockets, last, tick } = setup([ok])
    link.start()
    await flush()
    sockets[0]!.recv({ t: "welcome", v: 1, machine: "mac", device: "iphone", permission: "send" })
    await tick(30_000)
    sockets[0]!.recv({ t: "tick" })
    await tick(30_000)
    expect(last().state).toBe("open")
    await tick(10_000)
    expect(sockets[0]!.closed).toBe(true)
    expect(last().state).toBe("reconnecting")
  })

  it("stops on locked, no access, removed and version", async () => {
    const locked: SessionState = { state: "locked", machine: "mac", device: "iphone", pin: true }
    const a = setup([locked])
    a.link.start()
    await flush()
    expect(a.last()).toEqual({ state: "locked", pin: true, machine: "mac", device: "iphone" })

    const b = setup([ok])
    b.link.start()
    await flush()
    b.sockets[0]!.recv({ t: "bye", reason: "revoked" })
    expect(b.last()).toEqual({ state: "removed" })
    await b.tick(60_000)
    expect(b.sockets).toHaveLength(1) // no retry

    const d = setup([ok])
    d.link.start()
    await flush()
    d.sockets[0]!.recv({ t: "welcome", v: 1, machine: "mac", device: "iphone", permission: "send" })
    d.sockets[0]!.recv({ t: "bye", reason: "disconnected" })
    expect(d.last()).toEqual({ state: "disconnected", machine: "mac" })
    await d.tick(60_000)
    expect(d.sockets).toHaveLength(1) // "Disconnect all" sticks

    const c = setup([ok])
    c.link.start()
    await flush()
    c.sockets[0]!.recv({ t: "bye", reason: "version" })
    expect(c.last()).toEqual({ state: "version" })
  })

  it("wake reconnects at once when the link is down", async () => {
    const { link, sockets, tick } = setup([ok])
    link.start()
    await flush()
    sockets[0]!.onclose!()
    link.wake()
    await flush()
    expect(sockets).toHaveLength(2)
    await tick(0)
  })

  it("wake does nothing while the first check is still running", async () => {
    const { link, sockets } = setup([ok])
    link.start()
    link.wake() // pageshow on first load
    await flush()
    expect(sockets).toHaveLength(1)
  })

  it("backoff doubles up to 30 s", () => {
    expect([1, 2, 3, 4, 5, 6, 7].map(backoffMs)).toEqual([
      1000, 2000, 4000, 8000, 16000, 30000, 30000,
    ])
  })
})
