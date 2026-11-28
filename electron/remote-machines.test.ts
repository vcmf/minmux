// @vitest-environment node
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { peerRefOf, setupRemoteMachines, type ClientProc } from "./remote-machines"
import type { FromClient, ToClient } from "./remote/client-messages"

class FakeProc implements ClientProc {
  sent: ToClient[] = []
  private handlers: { message: ((m: unknown) => void)[]; exit: ((c: number) => void)[] } = {
    message: [],
    exit: [],
  }
  killed = false
  postMessage(m: unknown) {
    this.sent.push(m as ToClient)
  }
  on(ev: "message" | "exit", fn: (x: never) => void) {
    ;(this.handlers[ev] as ((x: never) => void)[]).push(fn)
    return this
  }
  kill() {
    this.killed = true
    return true
  }
  emit(m: FromClient) {
    this.handlers.message.forEach((f) => f(m))
  }
  exit() {
    this.handlers.exit.forEach((f) => f(1))
  }
}

class FakeSender {
  got: [string, ...unknown[]][] = []
  destroyed = false
  send(channel: string, ...args: unknown[]) {
    this.got.push([channel, ...args])
  }
  isDestroyed() {
    return this.destroyed
  }
}

const tick = () => new Promise((r) => setTimeout(r, 20))

describe("remote machines (main)", () => {
  let dir: string
  let procs: FakeProc[]
  let lists: unknown[]
  let rm: ReturnType<typeof setupRemoteMachines>

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "machines-"))
    procs = []
    lists = []
    rm = setupRemoteMachines({
      configDir: () => dir,
      fork: () => {
        const p = new FakeProc()
        procs.push(p)
        return p
      },
      onMachines: (l) => lists.push(l),
    })
  })
  afterEach(() => rm.dispose())

  it("a surface: opened once the worker has its tokens, then screen, output, size, notes", async () => {
    fs.writeFileSync(
      path.join(dir, "remote-machines.json"),
      JSON.stringify({ v: 1, machines: { "mac:7420": { token: "tok" }, bad: { token: 5 } } }),
    )
    const s = new FakeSender()
    expect(rm.spawn(s, "s1", { key: "mac:7420", pane: "p1" })).toEqual({ reattached: false })
    const p = procs[0]!
    expect(p.sent).toEqual([]) // tokens not read yet: nothing opened
    await tick()
    expect(p.sent.slice(0, 3)).toEqual([
      { t: "tokens", tokens: { "mac:7420": "tok" } },
      { t: "list", on: false },
      { t: "open", sid: "s1", key: "mac:7420", pane: "p1" },
    ])
    expect(rm.has("s1")).toBe(true)
    expect(rm.ids()).toEqual(["s1"])

    p.emit({ t: "snap", sid: "s1", cols: 100, rows: 30, data: "screen" })
    expect(s.got).toEqual([
      ["pty:pinned:s1", 100, 30],
      ["pty:data:s1", "\x1bcscreen"],
    ])
    p.emit({ t: "out", sid: "s1", data: " more" })
    p.emit({ t: "size", sid: "s1", cols: 90, rows: 20 })
    p.emit({ t: "note", sid: "s1", text: "that pane was closed" })
    expect(s.got.slice(2).map((x) => x[0])).toEqual(["pty:data:s1", "pty:pinned:s1", "pty:data:s1"])
    p.emit({ t: "out", sid: "nope", data: "x" }) // not ours: dropped

    // A reloaded renderer asks again: the same surface, its size and what it showed since.
    const s2 = new FakeSender()
    expect(rm.spawn(s2, "s1", { key: "mac:7420", pane: "p1" })).toEqual({ reattached: true })
    expect(s2.got[0]).toEqual(["pty:pinned:s1", 90, 20])
    expect(String(s2.got[1]![1])).toContain("\x1bcscreen more")

    expect(p.sent.at(-1)).toEqual({ t: "refresh", sid: "s1" }) // and a clean screen follows
    // More output since its clean screen than the buffer holds: no replay (its base is gone).
    p.emit({ t: "out", sid: "s1", data: "x".repeat(300 * 1024) })
    const s3 = new FakeSender()
    rm.spawn(s3, "s1", { key: "mac:7420", pane: "p1" })
    expect(s3.got.map((x) => x[0])).toEqual(["pty:pinned:s1"])

    rm.write("s1", "ls\r")
    expect(p.sent.slice(-2)).toEqual([{ t: "keys", sid: "s1", data: "ls\r" }, { t: "seen" }])
    rm.write("nope", "x") // not a surface: nothing
    rm.kill("s1")
    expect(p.sent.at(-1)).toEqual({ t: "close", sid: "s1" })
    rm.kill("s1") // twice: nothing
  })

  it("the list: starts the worker, relays machines, saves and forgets tokens", async () => {
    rm.list(true)
    const p = procs[0]!
    expect(p.sent).toEqual([]) // not before its tokens (it would list approved machines as new)
    await tick()
    p.emit({ t: "machines", machines: [{ key: "mac:7420", label: "mac", state: "new" }] })
    expect(lists.at(-1)).toEqual([{ key: "mac:7420", label: "mac", state: "new" }])
    expect(rm.machines()).toHaveLength(1)
    rm.pair("mac:7420")
    expect(p.sent.at(-1)).toEqual({ t: "pair", key: "mac:7420" })
    p.emit({ t: "token", key: "mac:7420", token: "secret" })
    await vi.waitFor(() => {
      const f = path.join(dir, "remote-machines.json")
      expect(JSON.parse(fs.readFileSync(f, "utf8")).machines["mac:7420"].token).toBe("secret")
      if (process.platform !== "win32") expect(fs.statSync(f).mode & 0o777).toBe(0o600)
    })
    rm.forget("mac:7420")
    expect(p.sent.at(-1)).toEqual({ t: "forget", key: "mac:7420" })
    await vi.waitFor(() =>
      expect(
        JSON.parse(fs.readFileSync(path.join(dir, "remote-machines.json"), "utf8")).machines,
      ).toEqual({}),
    )
    p.emit({ t: "token", key: "x:1", token: null })
  })

  it("asking for access keeps the worker; focused output counts as use; its own port", async () => {
    vi.useFakeTimers()
    try {
      let focused = false
      const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), "machines-"))
      const ps: FakeProc[] = []
      const rm2 = setupRemoteMachines({
        configDir: () => dir2,
        fork: () => {
          const p = new FakeProc()
          ps.push(p)
          return p
        },
        onMachines: () => {},
        ownPort: () => 7458,
        focused: () => focused,
      })
      rm2.list(true)
      await vi.advanceTimersByTimeAsync(10)
      const p = ps[0]!
      expect(p.sent[0]).toEqual({ t: "port", own: 7458 })
      p.emit({
        t: "machines",
        machines: [{ key: "k:1", label: "k", state: "pairing", code: "AB" }],
      })
      rm2.list(false) // hidden while asking: kept
      await vi.advanceTimersByTimeAsync(40_000)
      expect(p.killed).toBe(false)
      p.emit({ t: "machines", machines: [{ key: "k:1", label: "k", state: "connected" }] })
      await vi.advanceTimersByTimeAsync(31_000)
      expect(p.killed).toBe(true)
      // A surface's output while the window has focus: "seen", at most once a minute.
      rm2.spawn(new FakeSender(), "s1", { key: "k:1", pane: "p" })
      await vi.advanceTimersByTimeAsync(10)
      const q = ps[1]!
      focused = true
      q.emit({ t: "out", sid: "s1", data: "a" })
      q.emit({ t: "out", sid: "s1", data: "b" })
      expect(q.sent.filter((m) => m.t === "seen")).toHaveLength(1)
      rm2.connect("k:1")
      expect(q.sent.at(-1)).toEqual({ t: "connect", key: "k:1" })
      rm2.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it("a worker that dies while wanted is started again; unwanted, it stops", async () => {
    vi.useFakeTimers()
    try {
      rm.list(true)
      procs[0]!.exit()
      expect(lists.at(-1)).toEqual([])
      await vi.advanceTimersByTimeAsync(1100)
      expect(procs).toHaveLength(2)
      procs[1]!.exit() // dies at once again: waits longer
      await vi.advanceTimersByTimeAsync(1100)
      expect(procs).toHaveLength(2)
      await vi.advanceTimersByTimeAsync(1000)
      expect(procs).toHaveLength(3)
      procs.splice(1, 1)
      procs[0]!.emit({ t: "machines", machines: [] }) // the old one: ignored
      rm.list(false)
      await vi.advanceTimersByTimeAsync(31_000)
      expect(procs[1]!.killed).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it("an unreadable token file starts over; a destroyed window gets nothing", async () => {
    fs.writeFileSync(path.join(dir, "remote-machines.json"), "{not json")
    const s = new FakeSender()
    s.destroyed = true
    rm.spawn(s, "s1", { key: "mac:7420", pane: "p1" })
    await tick()
    expect(procs[0]!.sent[0]).toEqual({ t: "tokens", tokens: {} })
    procs[0]!.emit({ t: "snap", sid: "s1", cols: 80, rows: 24, data: "x" })
    expect(s.got).toEqual([])
    // Another pane under the same surface id: the old one is closed first.
    rm.spawn(new FakeSender(), "s1", { key: "mac:7420", pane: "p2" })
    expect(procs[0]!.sent.slice(-2)).toEqual([
      { t: "close", sid: "s1" },
      { t: "open", sid: "s1", key: "mac:7420", pane: "p2" },
    ])
  })
})

describe("peerRefOf", () => {
  it("takes a machine key and a pane id, nothing else", () => {
    expect(peerRefOf({ key: "mac.tail.ts.net:7420", pane: "p", machine: "x" })).toEqual({
      key: "mac.tail.ts.net:7420",
      pane: "p",
    })
    expect(peerRefOf({ key: "[fd7a::1]:7420", pane: "p" })).toBeTruthy()
    expect(peerRefOf(null)).toBeNull()
    expect(peerRefOf({ key: "mac", pane: "p" })).toBeNull() // no port
    expect(peerRefOf({ key: "mac:1; rm", pane: "p" })).toBeNull()
    expect(peerRefOf({ key: "mac:7420", pane: "" })).toBeNull()
    expect(peerRefOf({ key: "mac:7420", pane: 3 })).toBeNull()
  })
})

describe("remote machines: quitting", () => {
  it("no worker is started while draining or after dispose, nor restarted after it", async () => {
    vi.useFakeTimers()
    try {
      const procs: FakeProc[] = []
      let draining = false
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "machines-"))
      const rm = setupRemoteMachines({
        configDir: () => dir,
        fork: () => {
          const p = new FakeProc()
          procs.push(p)
          return p
        },
        onMachines: () => {},
        draining: () => draining,
      })
      rm.list(true)
      procs[0]!.exit()
      rm.dispose()
      await vi.advanceTimersByTimeAsync(5000)
      expect(procs).toHaveLength(1)
      const rm2 = setupRemoteMachines({
        configDir: () => dir,
        fork: () => {
          const p = new FakeProc()
          procs.push(p)
          return p
        },
        onMachines: () => {},
        draining: () => draining,
      })
      draining = true
      rm2.list(true)
      expect(procs).toHaveLength(1)
      rm2.dispose()
    } finally {
      vi.useRealTimers()
    }
  })
})
