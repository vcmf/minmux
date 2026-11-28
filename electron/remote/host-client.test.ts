import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { DeviceTable } from "./devices"
import { RemoteHost, type HostProc } from "./host-client"
import type { FromHost, ToHost } from "./host-messages"

class FakeProc implements HostProc {
  sent: ToHost[] = []
  killed = false
  private handlers: { message: ((m: FromHost) => void)[]; exit: ((c: number) => void)[] } = {
    message: [],
    exit: [],
  }
  postMessage(m: ToHost) {
    this.sent.push(m)
  }
  on(ev: "message" | "exit", fn: (x: never) => void) {
    ;(this.handlers[ev] as ((x: never) => void)[]).push(fn)
  }
  kill() {
    this.killed = true
    return true
  }
  emit(m: FromHost) {
    this.handlers.message.forEach((f) => f(m))
  }
  exit() {
    this.handlers.exit.forEach((f) => f(1))
  }
}

const config = { port: 7420, staticDir: "/x" }
const flush = () => new Promise((r) => setImmediate(r))

describe("RemoteHost", () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }))
  afterEach(() => vi.useRealTimers())

  function setup(answer: "allow" | "view" | "deny" = "allow") {
    const procs: FakeProc[] = []
    const table = new DeviceTable(null, { save: () => {}, derive: async (p, s) => `${s}${p}` })
    const changes = vi.fn()
    const gone = vi.fn()
    const host = new RemoteHost({
      fork: () => {
        const p = new FakeProc()
        procs.push(p)
        return p
      },
      devices: async () => table,
      ask: async () => answer,
      onChange: changes,
      workerGone: gone,
    })
    return { host, procs, table, changes, gone }
  }

  it("no worker until turned on; off kills it", () => {
    const { host, procs } = setup()
    host.apply(null)
    expect(procs).toHaveLength(0)
    host.apply(config)
    expect(procs).toHaveLength(1)
    expect(procs[0]!.sent[0]).toEqual({ t: "config", config })
    host.apply(config) // unchanged: no restart
    expect(procs).toHaveLength(1)
    host.apply(null)
    expect(procs[0]!.sent.at(-1)).toEqual({ t: "drop", reason: "off" })
    vi.advanceTimersByTime(300)
    expect(procs[0]!.killed).toBe(true)
    expect(host.state.status).toEqual({ state: "off" })
  })

  it("restarts a crashed worker while on (its taps are gone with it)", () => {
    const { host, procs, gone } = setup()
    host.apply(config)
    procs[0]!.exit()
    expect(gone).toHaveBeenCalledTimes(1)
    expect(host.state.status).toMatchObject({ state: "error" })
    vi.advanceTimersByTime(2000)
    expect(procs).toHaveLength(2)
  })

  it("answers approval: dialog, then the page collects its token", async () => {
    const { host, procs, table } = setup("allow")
    host.apply(config)
    const p = procs[0]!
    p.emit({ t: "rpc", id: 1, call: { op: "approve", nodeId: "n1", name: "iphone-15" } })
    await flush()
    const reply = p.sent.find((m) => m.t === "rpc" && m.id === 1) as Extract<ToHost, { t: "rpc" }>
    const pending = (reply.result as { result: { id: string } }).result
    await flush()
    p.emit({ t: "rpc", id: 2, call: { op: "pending", id: pending.id, nodeId: "n1" } })
    await flush()
    const got = p.sent.find((m) => m.t === "rpc" && m.id === 2) as Extract<ToHost, { t: "rpc" }>
    expect(got.result).toMatchObject({ op: "pending", result: { state: "approved" } })
    expect(table.list()).toHaveLength(1)
  })

  it("a failed answer still replies, with the safe no", async () => {
    const { host, procs, table } = setup()
    table.unlock = async () => {
      throw new Error("scrypt")
    }
    host.apply(config)
    procs[0]!.emit({ t: "rpc", id: 7, call: { op: "unlock", token: "t", nodeId: "n", pin: "1" } })
    await flush()
    await flush()
    expect(procs[0]!.sent.find((m) => m.t === "rpc" && m.id === 7)).toEqual({
      t: "rpc",
      id: 7,
      result: { op: "unlock", result: "unknown" },
    })
  })

  it("wanted follows connected clients, and sends the latest panes to a new first client", () => {
    const { host, procs } = setup()
    host.apply(config)
    const panes = { tabs: [], panes: [], stale: false }
    host.setPanes(panes)
    expect(host.wanted).toBe(false)
    procs[0]!.emit({ t: "clients", clients: [{ deviceId: "d", name: "iphone" }] })
    expect(host.wanted).toBe(true)
    expect(procs[0]!.sent.filter((m) => m.t === "panes")).toHaveLength(2)
  })
})
