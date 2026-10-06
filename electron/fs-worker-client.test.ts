import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { FsWorkerClient, type WorkerProc } from "./fs-worker-client"
import type { FsReply, FsRequest } from "./fs-worker-ops"

/** A fake utility process: records requests; the test answers them. */
function fakeProc() {
  const sent: FsRequest[] = []
  let onMessage: (m: FsReply) => void = () => {}
  let onExit: (c: number) => void = () => {}
  const proc = {
    sent,
    killed: false,
    postMessage: (m: FsRequest) => void sent.push(m),
    on: (ev: string, fn: (x: never) => void) => {
      if (ev === "message") onMessage = fn as typeof onMessage
      else onExit = fn as typeof onExit
    },
    kill: () => (proc.killed = true),
    reply: (m: FsReply) => onMessage(m),
    exit: () => onExit(1),
  }
  return proc
}

let procs: ReturnType<typeof fakeProc>[] = []
const client = () =>
  new FsWorkerClient(
    () => {
      const p = fakeProc()
      procs.push(p)
      return p as unknown as WorkerProc
    },
    1000,
    5000,
  )
const listing = { entries: [], truncated: false, total: 0 }

beforeEach(() => {
  procs = []
  vi.useFakeTimers()
})
afterEach(() => vi.useRealTimers())

describe("FsWorkerClient", () => {
  it("starts the worker on first use and matches replies to requests by id", async () => {
    const c = client()
    expect(procs).toHaveLength(0)
    const a = c.call({ op: "readdir", path: "/a" })
    const b = c.call({ op: "stat", path: "/" })
    expect(procs).toHaveLength(1)
    const [ra, rb] = procs[0]!.sent
    procs[0]!.reply({ id: rb!.id, ok: true, value: { isDir: true } })
    procs[0]!.reply({ id: ra!.id, ok: false, code: "ENOENT" })
    await expect(b).resolves.toEqual({ isDir: true })
    await expect(a).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("a hung request fails alone; the worker is retired and a fresh one takes new requests", async () => {
    const c = client()
    const stuck = c.call({ op: "readdir", path: "/mnt/dead" })
    vi.advanceTimersByTime(800)
    const healthy = c.call({ op: "readdir", path: "/home" }) // same worker, sent later
    vi.advanceTimersByTime(500) // the first passes the hung limit; the second doesn't
    await expect(stuck).rejects.toMatchObject({ code: "EHUNG" })
    expect(procs[0]!.killed).toBe(false) // it still holds a read that can finish
    const next = c.call({ op: "readdir", path: "/x" })
    expect(procs).toHaveLength(2) // new requests go to a fresh worker
    procs[0]!.reply({ id: procs[0]!.sent[1]!.id, ok: true, value: listing })
    await expect(healthy).resolves.toEqual(listing) // not collateral
    expect(procs[0]!.killed).toBe(true) // only the hung read is left: retired worker killed
    procs[1]!.reply({ id: procs[1]!.sent[0]!.id, ok: true, value: listing })
    await expect(next).resolves.toEqual(listing)
  })

  it("a late reply to a request that already failed as hung is ignored", async () => {
    const c = client()
    const first = c.call({ op: "readdir", path: "/slow" })
    vi.advanceTimersByTime(1300)
    await expect(first).rejects.toMatchObject({ code: "EHUNG" })
    procs[0]!.reply({ id: procs[0]!.sent[0]!.id, ok: true, value: listing }) // no throw, no effect
  })

  it("at most MAX_RETIRED stuck workers wait to exit; past that, requests fail fast", async () => {
    const c = client()
    for (let i = 0; i < 3; i++) {
      const p = c.call({ op: "readdir", path: `/dead${i}` })
      vi.advanceTimersByTime(1300)
      await expect(p).rejects.toMatchObject({ code: "EHUNG" })
    }
    expect(procs).toHaveLength(3)
    await expect(c.call({ op: "readdir", path: "/home" })).rejects.toMatchObject({ code: "EBUSY" })
    expect(procs).toHaveLength(3) // no fourth process
    procs[0]!.exit() // one stuck worker finally exits: room again
    void c.call({ op: "readdir", path: "/home" }).catch(() => {})
    expect(procs).toHaveLength(4)
  })

  it("a crashed worker fails what it held; the next call starts a new one", async () => {
    const c = client()
    const p = c.call({ op: "readdir", path: "/a" })
    procs[0]!.exit()
    await expect(p).rejects.toMatchObject({ code: "EWORKER" })
    void c.call({ op: "readdir", path: "/a" }).catch(() => {})
    expect(procs).toHaveLength(2)
  })

  it("an idle worker is shut down; nothing is killed while a request waits", async () => {
    const c = client()
    const p = c.call({ op: "readdir", path: "/a" })
    vi.advanceTimersByTime(900) // under the hung limit
    expect(procs[0]!.killed).toBe(false)
    procs[0]!.reply({ id: procs[0]!.sent[0]!.id, ok: true, value: listing })
    await p
    vi.advanceTimersByTime(4900)
    expect(procs[0]!.killed).toBe(false)
    vi.advanceTimersByTime(200)
    expect(procs[0]!.killed).toBe(true)
  })

  it("dispose stops the worker and fails what's waiting", async () => {
    const c = client()
    const p = c.call({ op: "readdir", path: "/a" })
    c.dispose()
    await expect(p).rejects.toMatchObject({ code: "EWORKER" })
    expect(procs[0]!.killed).toBe(true)
  })
})
