import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { SessionHit } from "../src/lib/past-sessions"
import type { ListedSession } from "./agents/types"
import { SessionsOps, type SessionsReply, type SessionsRequest } from "./sessions-ops"
import { SessionsWorkerClient, type SessionsProc } from "./sessions-worker-client"

const listed = (o: Partial<ListedSession>): ListedSession => ({
  agent: "claude",
  sessionId: "a",
  updatedAt: 1,
  ...o,
})

describe("SessionsOps", () => {
  let dir: string
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ops-"))
  })
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

  const ops = (rows: ListedSession[]) => {
    const replies: SessionsReply[] = []
    const o = new SessionsOps(
      {
        claude: {
          history: { list: async () => rows },
          texts: (line) => (typeof line.text === "string" ? [line.text] : []),
          quick: () => true,
        },
      },
      (r) => replies.push(r),
    )
    const settled = async (id: number) => {
      await vi.waitFor(() => expect(replies.some((r) => r.id === id && "ok" in r)).toBe(true))
      return replies.filter((r) => r.id === id)
    }
    return { o, replies, settled }
  }

  it("lists an agent's sessions; an unknown agent has none", async () => {
    const { o, settled } = ops([listed({})])
    o.handle({ id: 1, op: "list", agent: "claude" })
    o.handle({ id: 2, op: "list", agent: "codex" })
    expect(await settled(1)).toEqual([{ id: 1, ok: true, value: [listed({})] }])
    expect(await settled(2)).toEqual([{ id: 2, ok: true, value: [] }])
  })

  it("searches only the sessions in the folder asked for", async () => {
    const a = path.join(dir, "a.jsonl")
    const b = path.join(dir, "b.jsonl")
    for (const f of [a, b]) fs.writeFileSync(f, JSON.stringify({ text: "quit" }) + "\n")
    const { o, replies, settled } = ops([
      listed({ sessionId: "in", cwd: "/w/term/sub", transcriptPath: a }),
      listed({ sessionId: "out", cwd: "/w/other", transcriptPath: b }),
    ])
    o.handle({ id: 4, op: "search", query: "quit", agents: ["claude"], rg: null, under: "/w/term" })
    await settled(4)
    expect(replies.flatMap((r) => ("hit" in r ? [r.hit.sessionId] : []))).toEqual(["in"])
  })

  it("shares a listing while it runs; a search reuses a recent one", async () => {
    let reads = 0
    const replies: SessionsReply[] = []
    const o = new SessionsOps(
      {
        claude: {
          history: {
            list: async () => {
              reads++
              await new Promise((r) => setTimeout(r, 10))
              return []
            },
          },
          texts: () => [],
          quick: () => true,
        },
      },
      (r) => replies.push(r),
    )
    o.handle({ id: 1, op: "list", agent: "claude" })
    o.handle({ id: 2, op: "list", agent: "claude" })
    await vi.waitFor(() => expect(replies.filter((r) => "ok" in r)).toHaveLength(2))
    expect(reads).toBe(1)
    o.handle({ id: 3, op: "search", query: "quit", agents: ["claude"], rg: null })
    await vi.waitFor(() => expect(replies.filter((r) => "ok" in r)).toHaveLength(3))
    expect(reads).toBe(1) // reused
  })

  it("searches the listed transcripts, posting each hit, then done", async () => {
    const f = path.join(dir, "a.jsonl")
    fs.writeFileSync(f, JSON.stringify({ text: "the quit drain" }) + "\n")
    const { o, settled } = ops([listed({ transcriptPath: f })])
    o.handle({ id: 3, op: "search", query: "QUIT", agents: ["claude"], rg: null })
    const out = await settled(3)
    expect(out[0]).toMatchObject({ id: 3, hit: { agent: "claude", sessionId: "a" } })
    // Its row comes with it (main records it for a resume, and strips the path).
    expect((out[0] as { hit: { session: object } }).hit.session).toEqual(
      listed({ transcriptPath: f }),
    )
    expect(out[1]).toEqual({ id: 3, ok: true, value: { capped: false } })
  })
})

// A fake worker process: what main posts, and a way to answer as the worker would.
function fakeProc() {
  const sent: SessionsRequest[] = []
  let onMsg: (m: SessionsReply) => void = () => {}
  let onExit: (c: number) => void = () => {}
  const proc: SessionsProc & { killed: boolean } = {
    killed: false,
    postMessage: (m) => sent.push(m),
    on: ((ev: string, fn: never) => {
      if (ev === "message") onMsg = fn
      else onExit = fn
    }) as SessionsProc["on"],
    kill: () => (proc.killed = true),
  }
  return { proc, sent, reply: (m: SessionsReply) => onMsg(m), exit: () => onExit(1) }
}

describe("SessionsWorkerClient", () => {
  afterEach(() => vi.useRealTimers())

  it("starts the worker on first use and answers by request id", async () => {
    const w = fakeProc()
    const fork = vi.fn(() => w.proc)
    const c = new SessionsWorkerClient(fork)
    expect(fork).not.toHaveBeenCalled()
    const p = c.list("claude")
    expect(w.sent).toEqual([{ id: 1, op: "list", agent: "claude" }])
    w.reply({ id: 1, ok: true, value: [listed({})] })
    expect(await p).toEqual([listed({})])
    c.dispose()
  })

  it("streams a search's hits, then its end; cancel tells the worker", async () => {
    const w = fakeProc()
    const c = new SessionsWorkerClient(() => w.proc)
    const hits: SessionHit[] = []
    const s = c.search("quit", ["claude"], "/bin/rg", undefined, (h) => hits.push(h))
    const hit: SessionHit = {
      agent: "claude",
      sessionId: "a",
      snippet: "quit",
      match: 0,
      length: 4,
    }
    w.reply({ id: 1, hit })
    s.cancel()
    expect(w.sent[1]).toEqual({ id: 1, op: "cancel" })
    w.reply({ id: 1, ok: true, value: { capped: false } })
    expect(await s.done).toEqual({ capped: false })
    expect(hits).toEqual([hit])
    c.dispose()
  })

  it("a stuck worker is killed, what it held fails, and the next call starts a new one", async () => {
    vi.useFakeTimers()
    const first = fakeProc()
    const second = fakeProc()
    const fork = vi.fn().mockReturnValueOnce(first.proc).mockReturnValueOnce(second.proc)
    const c = new SessionsWorkerClient(fork, { listMs: 100 })
    const p = c.list("claude")
    const failed = expect(p).rejects.toMatchObject({ code: "EHUNG" })
    await vi.advanceTimersByTimeAsync(150)
    await failed
    expect(first.proc.killed).toBe(true)
    const next = c.list("codex")
    second.reply({ id: 2, ok: true, value: [] })
    expect(await next).toEqual([])
    c.dispose()
  })

  it("a worker that exits fails what it held; an error reply rejects with its code", async () => {
    const w = fakeProc()
    const c = new SessionsWorkerClient(() => w.proc)
    const a = c.list("claude")
    const b = c.list("codex")
    w.reply({ id: 2, ok: false, code: "EACCES" })
    await expect(b).rejects.toMatchObject({ code: "EACCES" })
    w.exit()
    await expect(a).rejects.toMatchObject({ code: "EGONE" })
  })

  it("a worker that doesn't exit when stopped is force-killed", async () => {
    vi.useFakeTimers()
    const w = fakeProc()
    Object.assign(w.proc, { pid: 424242 })
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true)
    const c = new SessionsWorkerClient(() => w.proc)
    void c.list("claude").catch(() => {})
    c.dispose()
    await vi.advanceTimersByTimeAsync(2500)
    expect(kill).toHaveBeenCalledWith(424242, "SIGKILL")
    kill.mockRestore()
  })

  it("…but not one that exited", async () => {
    vi.useFakeTimers()
    const w = fakeProc()
    Object.assign(w.proc, { pid: 424243 })
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true)
    const c = new SessionsWorkerClient(() => w.proc)
    void c.list("claude").catch(() => {})
    c.dispose()
    w.exit()
    await vi.advanceTimersByTimeAsync(2500)
    expect(kill).not.toHaveBeenCalled()
    kill.mockRestore()
  })

  it("an idle worker is shut down, after any number of requests", async () => {
    vi.useFakeTimers()
    const w = fakeProc()
    const c = new SessionsWorkerClient(() => w.proc, { idleMs: 1000 })
    for (const id of [1, 2, 3]) {
      const p = c.list("claude")
      w.reply({ id, ok: true, value: [] })
      await p
    }
    await vi.advanceTimersByTimeAsync(1500)
    expect(w.proc.killed).toBe(true)
  })
})
