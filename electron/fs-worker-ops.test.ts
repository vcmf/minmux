import { describe, it, expect, beforeAll, afterAll, vi } from "vitest"
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  gitRootOf,
  gitRoots,
  handleFsRequest,
  Watches,
  WATCH_BATCH_MS,
  type FsEvent,
} from "./fs-worker-ops"

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

  it("on Linux, content-only changes come apart (a listing ignores them, a file tab not)", () => {
    vi.useFakeTimers()
    const out: FsEvent[] = []
    const fw = fakeWatch()
    const w = new Watches((e) => out.push(e), { watchFn: fw.fn, linux: true, idNow: () => "1" })
    w.add("/log")
    w.add("/src")
    fw.live.get("/log")!.fire("change", "app.log")
    fw.live.get("/src")!.fire("change", "a.ts")
    fw.live.get("/src")!.fire("rename", "b.ts") // an entry changed there too
    vi.advanceTimersByTime(WATCH_BATCH_MS)
    expect(out).toEqual([{ event: "changed", dirs: ["/src"], content: ["/log"] }])
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
    // busy machine delays delivery. So keep creating files until one is reported (~3.5 s max,
    // under the 5 s test timeout so a failure reports the assertion).
    const seen = () => out.some((e) => e.event === "changed" && e.dirs.includes(tmp))
    const deadline = Date.now() + 3500 // by the clock, under the 5 s test timeout
    for (let i = 0; !seen() && Date.now() < deadline; i++) {
      fs.writeFileSync(path.join(tmp, `new-${i}.txt`), "")
      await new Promise((r) => setTimeout(r, WATCH_BATCH_MS / 2))
    }
    w.closeAll()
    expect(out).toContainEqual({ event: "changed", dirs: [tmp] })
  })
})

describe("gitRootOf (the edits line's `.git` search)", () => {
  const repo = () => path.join(tmp, "repo")
  beforeAll(() => {
    const r = path.join(tmp, "repo")
    fs.mkdirSync(path.join(r, ".git", "worktrees", "f"), { recursive: true })
    fs.writeFileSync(path.join(r, ".git", "HEAD"), "ref: refs/heads/main\n")
    fs.mkdirSync(path.join(r, "src", "ui"), { recursive: true })
    fs.mkdirSync(path.join(r, ".worktrees", "f", "src"), { recursive: true })
    fs.writeFileSync(path.join(r, ".worktrees", "f", ".git"), "gitdir: ../../.git/worktrees/f\n")
  })

  it("the nearest folder holding a `.git`: a repo, or a nested worktree's `.git` file", async () => {
    expect(await gitRootOf(path.join(repo(), "src", "ui"), true)).toBe(repo())
    expect(await gitRootOf(repo(), true)).toBe(repo())
    const wt = path.join(repo(), ".worktrees", "f")
    expect(await gitRootOf(path.join(wt, "src"), true)).toBe(wt)
    const res = await handleFsRequest({
      id: 9,
      op: "gitroots",
      paths: [path.join(repo(), "src"), wt],
      real: true,
    })
    expect(res).toEqual({
      id: 9,
      ok: true,
      value: { roots: { [path.join(repo(), "src")]: repo(), [wt]: wt } },
    })
  })

  it("a `.git` git wouldn't take: an empty folder is passed over, a dead link is no repo", async () => {
    const empty = path.join(repo(), "vendor", "x")
    fs.mkdirSync(path.join(empty, ".git"), { recursive: true }) // no HEAD
    expect(await gitRootOf(empty, true)).toBe(repo())
    const pruned = path.join(repo(), ".worktrees", "pruned")
    fs.mkdirSync(pruned, { recursive: true })
    fs.writeFileSync(path.join(pruned, ".git"), "gitdir: ../../.git/worktrees/pruned\n")
    expect(await gitRootOf(pruned, true)).toBeNull()
    const junk = path.join(repo(), ".worktrees", "junk")
    fs.mkdirSync(junk, { recursive: true })
    fs.writeFileSync(path.join(junk, ".git"), "nonsense\ngitdir: ../../.git/worktrees/f\n")
    expect(await gitRootOf(junk, true)).toBeNull() // `gitdir:` only counts on line 1
  })

  it("symlinks resolved first: a linked folder is in its target's checkout", async () => {
    const other = path.join(tmp, "other")
    fs.mkdirSync(path.join(other, ".git"), { recursive: true })
    fs.writeFileSync(path.join(other, ".git", "HEAD"), "ref: refs/heads/main\n")
    fs.mkdirSync(path.join(other, "lib"))
    fs.symlinkSync(path.join(other, "lib"), path.join(repo(), "src", "lib"))
    expect(await gitRootOf(path.join(repo(), "src", "lib"), true)).toBe(other)
    // Not resolved (a WSL share's spelling): the typed path's parents.
    expect(await gitRootOf(path.join(repo(), "src", "lib"), false)).toBe(repo())
  })

  it("a removed folder (or whole tree) is in none, never the repo around it", async () => {
    expect(await gitRootOf(path.join(repo(), "src", "gone"), true)).toBeNull()
    expect(await gitRootOf(path.join(repo(), "gone", "x", "y"), true)).toBeNull()
  })

  it("an unreadable `.git` fails the search (git's turn), never passes it over", async () => {
    if (process.platform === "win32" || process.getuid?.() === 0) return
    const locked = path.join(repo(), "locked")
    fs.mkdirSync(path.join(locked, ".git"), { recursive: true })
    fs.chmodSync(path.join(locked, ".git"), 0o000)
    try {
      await expect(gitRootOf(locked, true)).rejects.toMatchObject({ code: "EACCES" })
    } finally {
      fs.chmodSync(path.join(locked, ".git"), 0o755)
    }
  })

  it("a folder that doesn't answer in time is left out; the others still answer", async () => {
    const ok = path.join(repo(), "src")
    const dead = "/mnt/dead/x"
    const real = fs.promises.realpath
    const spy = vi
      .spyOn(fs.promises, "realpath")
      .mockImplementation(((p: string) =>
        p === dead ? new Promise(() => {}) : real(p)) as typeof fs.promises.realpath)
    try {
      expect(await gitRoots([ok, dead], true, 200)).toEqual({ [ok]: repo() })
    } finally {
      spy.mockRestore()
    }
  })

  it("a FIFO named .git is never read", async () => {
    if (process.platform === "win32") return
    const odd = path.join(repo(), "odd")
    fs.mkdirSync(odd)
    execFileSync("mkfifo", [path.join(odd, ".git")])
    expect(await gitRootOf(odd, true)).toBeNull()
  })

  it("no `.git` in it: the search goes on up past it", async () => {
    // Whatever lies above tmp on this machine, a folder in tmp without one gets tmp's answer.
    const plain = path.join(tmp, "sub")
    expect(await gitRootOf(plain, true)).toBe(await gitRootOf(tmp, true))
  })
})
