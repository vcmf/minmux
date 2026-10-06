import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { FsWorkerClient, type WorkerProc } from "./fs-worker-client"
import type { FsEvent, FsReply, FsRequest } from "./fs-worker-ops"

/** A fake utility process: records requests; the test answers them. */
function fakeProc() {
  const sent: FsRequest[] = []
  let onMessage: (m: FsReply | FsEvent) => void = () => {}
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
    reply: (m: FsReply | FsEvent) => onMessage(m),
    /** Answer every unanswered watch / unwatch request OK. */
    ackWatches: () => {
      for (const r of sent.splice(0)) {
        if (r.op === "watch" || r.op === "unwatch")
          onMessage({ id: r.id, ok: true, value: { watching: r.op === "watch" } })
      }
    },
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

  it("a hung request fails alone; reads stranded behind it move to a fresh worker", async () => {
    const c = client()
    const stuck = c.call({ op: "readdir", path: "/mnt/dead" })
    vi.advanceTimersByTime(800)
    const healthy = c.call({ op: "readdir", path: "/home" }) // queued behind it, same worker
    vi.advanceTimersByTime(500) // the first passes the hung limit; the second doesn't
    await expect(stuck).rejects.toMatchObject({ code: "EHUNG" })
    expect(procs).toHaveLength(2) // a fresh worker…
    expect(procs[1]!.sent.map((r) => r.path)).toEqual(["/home"]) // …got the stranded read
    expect(procs[0]!.killed).toBe(true) // only the hung read was left on the old one
    procs[0]!.reply({ id: procs[0]!.sent[1]!.id, ok: true, value: { isDir: true } }) // ignored
    procs[1]!.reply({ id: procs[1]!.sent[0]!.id, ok: true, value: listing })
    await expect(healthy).resolves.toEqual(listing) // not collateral
    const next = c.call({ op: "readdir", path: "/x" })
    expect(procs).toHaveLength(2) // new requests go to the fresh worker
    procs[1]!.reply({ id: procs[1]!.sent[1]!.id, ok: true, value: listing })
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

describe("FsWorkerClient — watches", () => {
  const ops = (p: ReturnType<typeof fakeProc>) => p.sent.map((r) => `${r.op} ${r.path}`)

  it("setWatched adds and removes watchers to match; [] with no worker starts none", async () => {
    const c = client()
    c.setWatched([])
    expect(procs).toHaveLength(0)
    c.setWatched(["/a", "/b"])
    expect(ops(procs[0]!)).toEqual(["watch /a", "watch /b"])
    procs[0]!.ackWatches()
    await Promise.resolve()
    c.setWatched(["/b", "/c"])
    expect(ops(procs[0]!)).toEqual(["unwatch /a", "watch /c"])
  })

  it("forwards 'changed' from the live worker only", async () => {
    const c = client()
    const seen: string[][] = []
    c.onChanged = (dirs) => seen.push(dirs)
    c.setWatched(["/a"])
    procs[0]!.reply({ event: "changed", dirs: ["/a"] })
    expect(seen).toEqual([["/a"]])
  })

  it("a lost watcher is re-added a moment later (its folder recreated)", async () => {
    const c = client()
    c.setWatched(["/dist"])
    procs[0]!.ackWatches()
    await Promise.resolve()
    procs[0]!.reply({ event: "lost", dir: "/dist" })
    expect(ops(procs[0]!)).toEqual([])
    vi.advanceTimersByTime(1000)
    expect(ops(procs[0]!)).toEqual(["watch /dist"])
  })

  it("a fresh worker (after a crash) gets the watch set again", async () => {
    const c = client()
    c.setWatched(["/a"])
    procs[0]!.ackWatches()
    await Promise.resolve()
    procs[0]!.exit()
    vi.advanceTimersByTime(1)
    expect(procs).toHaveLength(2)
    expect(ops(procs[1]!)).toEqual(["watch /a"])
  })

  it("a folder whose watch call hung is never watched again; the others move on", async () => {
    const c = client()
    c.setWatched(["/mnt/dead", "/home"])
    procs[0]!.reply({ id: procs[0]!.sent[1]!.id, ok: true, value: { watching: true } }) // /home ok
    vi.advanceTimersByTime(1300) // /mnt/dead's watch hangs → EHUNG, worker retired
    await Promise.resolve()
    vi.advanceTimersByTime(1)
    expect(procs).toHaveLength(2)
    expect(ops(procs[1]!)).toEqual(["watch /home"])
    c.setWatched(["/mnt/dead", "/home"])
    procs[1]!.ackWatches()
    await Promise.resolve()
    c.setWatched(["/mnt/dead", "/home"])
    expect(ops(procs[1]!)).toEqual([])
  })

  it("a worker holding watchers isn't shut down when idle", async () => {
    const c = client()
    c.setWatched(["/a"])
    procs[0]!.ackWatches()
    await Promise.resolve()
    vi.advanceTimersByTime(10_000)
    expect(procs[0]!.killed).toBe(false)
    c.setWatched([])
    procs[0]!.ackWatches()
    await Promise.resolve()
    vi.advanceTimersByTime(6_000)
    expect(procs[0]!.killed).toBe(true)
  })
})
