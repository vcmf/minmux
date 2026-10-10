import { describe, it, expect, beforeAll, afterAll, vi } from "vitest"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { handleFsRequest, Watches, WATCH_BATCH_MS, type FsEvent } from "./fs-worker-ops"

let tmp = ""
beforeAll(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "minmux-fsw-")))
  fs.mkdirSync(path.join(tmp, "sub"))
  fs.writeFileSync(path.join(tmp, "a.txt"), "")
})
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }))

describe("handleFsRequest", () => {
  it("readdir replies with the bounded listing", async () => {
    expect(await handleFsRequest({ id: 1, op: "readdir", path: tmp })).toEqual({
      id: 1,
      ok: true,
      value: {
        entries: [
          { name: "sub", isDir: true },
          { name: "a.txt", isDir: false },
        ],
        truncated: false,
        total: 2,
      },
    })
  })

  it("stat replies whether it's a folder", async () => {
    expect(await handleFsRequest({ id: 2, op: "stat", path: tmp })).toEqual({
      id: 2,
      ok: true,
      value: { isDir: true },
    })
  })

  it("a failure is a reply carrying the error code, never a throw", async () => {
    expect(await handleFsRequest({ id: 3, op: "readdir", path: path.join(tmp, "nope") })).toEqual({
      id: 3,
      ok: false,
      code: "ENOENT",
    })
  })
})

describe("Watches (in the fs worker)", () => {
  /** A fake fs.watch: the test fires events / errors per folder. */
  const fakeWatch = () => {
    const live = new Map<string, { fire: (t: string, n: string | null) => void; err: () => void }>()
    const closed: string[] = []
    const fn = (
      dir: string,
      onEvent: (t: string, n: string | null) => void,
      onError: () => void,
    ) => {
      live.set(dir, { fire: onEvent, err: onError })
      return { close: () => void closed.push(dir) }
    }
    return { fn, live, closed }
  }

  it("batches events per WATCH_BATCH_MS into one 'changed' naming each folder once", () => {
    vi.useFakeTimers()
    const out: FsEvent[] = []
    const fw = fakeWatch()
    const w = new Watches((e) => out.push(e), { watchFn: fw.fn, linux: false, idNow: () => "1" })
    w.add("/a")
    w.add("/b")
    for (let i = 0; i < 500; i++) fw.live.get("/a")!.fire("rename", `f${i}`)
    fw.live.get("/b")!.fire("change", "x")
    expect(out).toEqual([])
    vi.advanceTimersByTime(WATCH_BATCH_MS)
    expect(out).toEqual([{ event: "changed", dirs: ["/a", "/b"] }])
    vi.useRealTimers()
  })

  it("on Linux, content-only changes are ignored", () => {
    vi.useFakeTimers()
    const out: FsEvent[] = []
    const fw = fakeWatch()
    const w = new Watches((e) => out.push(e), { watchFn: fw.fn, linux: true, idNow: () => "1" })
    w.add("/log")
    fw.live.get("/log")!.fire("change", "app.log")
    vi.advanceTimersByTime(WATCH_BATCH_MS)
    expect(out).toEqual([])
    vi.useRealTimers()
  })

  it("Linux: a folder deleted or replaced under its watcher is reported lost", async () => {
    vi.useFakeTimers()
    const out: FsEvent[] = []
    const fw = fakeWatch()
    const ids = new Map([
      ["/dist", "1"],
      ["/src", "7"],
      ["/keep", "3"],
    ])
    const w = new Watches((e) => out.push(e), {
      watchFn: fw.fn,
      linux: true,
      idOf: async (d) => ids.get(d) ?? null,
      idNow: (d) => ids.get(d) ?? null,
    })
    w.add("/dist")
    w.add("/src")
    w.add("/keep")
    ids.set("/dist", "2") // rm -rf dist && mkdir dist: a new folder in its place
    ids.delete("/src") // deleted
    fw.live.get("/dist")!.fire("rename", "dist") // Linux names the folder itself
    fw.live.get("/src")!.fire("rename", "src")
    fw.live.get("/keep")!.fire("rename", "a-file") // a file inside renamed: same folder
    await vi.advanceTimersByTimeAsync(0)
    expect(out.filter((e) => e.event === "lost")).toEqual([
      { event: "lost", dir: "/dist" },
      { event: "lost", dir: "/src" },
    ])
    expect(fw.closed).toEqual(["/dist", "/src"])
    expect(w.size).toBe(1)
    await vi.advanceTimersByTimeAsync(WATCH_BATCH_MS)
    expect(out.at(-1)).toEqual({ event: "changed", dirs: ["/dist", "/src", "/keep", "/"] })
    vi.useRealTimers()
  })

  it("Linux: a rename during an identity check is checked again after it", async () => {
    vi.useFakeTimers()
    const out: FsEvent[] = []
    const fw = fakeWatch()
    let id: string | null = "1"
    let release!: () => void
    const first = new Promise<void>((r) => (release = r))
    let calls = 0
    const w = new Watches((e) => out.push(e), {
      watchFn: fw.fn,
      linux: true,
      idNow: () => "1",
      idOf: async () => {
        if (calls++ === 0) await first // the first check's stat ran before the folder went
        return calls === 1 ? "1" : id
      },
    })
    w.add("/dist")
    fw.live.get("/dist")!.fire("rename", "a.js") // a child: check starts (still "1")
    id = null // now the folder itself goes…
    fw.live.get("/dist")!.fire("rename", "dist") // …during that check
    release()
    await vi.advanceTimersByTimeAsync(0)
    expect(out.filter((e) => e.event === "lost")).toEqual([{ event: "lost", dir: "/dist" }])
    vi.useRealTimers()
  })

  it("Linux: an old watcher's late identity check can't drop the new watcher", async () => {
    const out: FsEvent[] = []
    const fw = fakeWatch()
    let release!: (v: string | null) => void
    const w = new Watches((e) => out.push(e), {
      watchFn: fw.fn,
      linux: true,
      idNow: () => "1",
      idOf: () => new Promise((r) => (release = r)),
    })
    w.add("/dist")
    fw.live.get("/dist")!.fire("rename", "dist") // check starts on the old watcher
    w.remove("/dist") // collapsed…
    w.add("/dist") // …and expanded again: a new watcher
    release(null) // the old check finally says "gone"
    await Promise.resolve()
    await Promise.resolve()
    expect(out.filter((e) => e.event === "lost")).toEqual([])
    expect(w.size).toBe(1)
    w.closeAll()
  })

  it("macOS: no identity checks (FSEvents follows the path)", async () => {
    let checks = 0
    const fw = fakeWatch()
    const w = new Watches(() => {}, {
      watchFn: fw.fn,
      linux: false,
      idNow: () => "1",
      idOf: async () => (checks++, "1"),
    })
    w.add("/logs")
    for (let i = 0; i < 50; i++) fw.live.get("/logs")!.fire("rename", "app.log") // appends
    await Promise.resolve()
    expect(checks).toBe(0)
    w.closeAll()
  })

  it("a watcher error: closed and reported lost", () => {
    const out: FsEvent[] = []
    const fw = fakeWatch()
    const w = new Watches((e) => out.push(e), { watchFn: fw.fn, linux: false, idNow: () => "1" })
    w.add("/x")
    fw.live.get("/x")!.err()
    expect(out).toEqual([{ event: "lost", dir: "/x" }])
    expect(w.size).toBe(0)
    w.closeAll()
  })

  it("watch / unwatch requests; a folder that can't be watched replies with its code", async () => {
    const w = new Watches(() => {})
    expect(await handleFsRequest({ id: 1, op: "watch", path: tmp }, w)).toMatchObject({ ok: true })
    expect(w.size).toBe(1)
    expect(await handleFsRequest({ id: 2, op: "unwatch", path: tmp }, w)).toMatchObject({
      ok: true,
    })
    expect(w.size).toBe(0)
    expect(await handleFsRequest({ id: 3, op: "watch", path: path.join(tmp, "nope") }, w)).toEqual({
      id: 3,
      ok: false,
      code: "ENOENT",
    })
    w.closeAll()
  })

  it("a real watcher reports a file created in the folder", async () => {
    const out: FsEvent[] = []
    const w = new Watches((e) => out.push(e))
    w.add(tmp)
    // macOS FSEvents registers asynchronously: a write right after add() can go unseen, and a
    // busy machine delays delivery. So keep creating files until one is reported (4 s max).
    const seen = () => out.some((e) => e.event === "changed" && e.dirs.includes(tmp))
    for (let i = 0; i < 40 && !seen(); i++) {
      fs.writeFileSync(path.join(tmp, `new-${i}.txt`), "")
      await new Promise((r) => setTimeout(r, WATCH_BATCH_MS / 2))
    }
    for (let i = 0; i < 20 && !seen(); i++) await new Promise((r) => setTimeout(r, 50))
    w.closeAll()
    expect(out).toContainEqual({ event: "changed", dirs: [tmp] })
  })
})
