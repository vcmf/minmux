import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  FileCache,
  cwdField,
  jsonlFiles,
  mapLimit,
  parseLine,
  readHeadTail,
  within,
} from "./history-read"
import { PastSessions } from "./past-sessions"
import type { PastSession } from "../src/lib/past-sessions"

let dir: string
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "hist-read-"))
})
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

describe("readHeadTail", () => {
  it("cuts both ends to whole lines", async () => {
    const f = path.join(dir, "t.jsonl")
    const lines = Array.from({ length: 50 }, (_, i) => `line-${String(i).padStart(2, "0")}`)
    fs.writeFileSync(f, lines.join("\n") + "\n")
    const size = fs.statSync(f).size
    const { head, tail } = await readHeadTail(f, size, 40, 40)
    expect(
      head
        .split("\n")
        .filter(Boolean)
        .every((l) => lines.includes(l)),
    ).toBe(true)
    expect(
      tail
        .split("\n")
        .filter(Boolean)
        .every((l) => lines.includes(l)),
    ).toBe(true)
    expect(head.startsWith("line-00")).toBe(true)
    expect(tail.trimEnd().endsWith("line-49")).toBe(true)
  })

  it("a line across the head's cut is in the tail whole", async () => {
    const f = path.join(dir, "t.jsonl")
    const long = '{"type":"custom-title","customTitle":"' + "x".repeat(30) + '"}'
    fs.writeFileSync(f, "short\n" + long + "\nend\n")
    const size = fs.statSync(f).size
    const { head, tail } = await readHeadTail(f, size, 20, size) // the cut falls inside `long`
    expect(head).toBe("short\n")
    expect(tail.split("\n")[0]).toBe(long)
  })

  it("a first line longer than the head is kept, cut, so its fields can still be found", async () => {
    const f = path.join(dir, "t.jsonl")
    const line = JSON.stringify({ cwd: "/w/x", pad: "y".repeat(500) })
    fs.writeFileSync(f, line + "\nnext\n")
    const { head } = await readHeadTail(f, fs.statSync(f).size, 100)
    expect(head).toBe(line.slice(0, 100))
    expect(cwdField(head)).toBe("/w/x")
    expect(cwdField('{"a":1}')).toBeUndefined()
    expect(cwdField('"cwd":"/w/\\"q\\""')).toBe('/w/"q"')
  })

  it("a small file is all head, no tail", async () => {
    const f = path.join(dir, "t.jsonl")
    fs.writeFileSync(f, "a\nb")
    expect(await readHeadTail(f, 3, 1024, 1024)).toEqual({ head: "a\nb", tail: "" })
  })
})

describe("FileCache", () => {
  it("answers while size and mtime match, and forgets files no longer listed", () => {
    const c = new FileCache<number>()
    c.set("/a", 10, 1, 42)
    expect(c.get("/a", 10, 1)).toBe(42)
    expect(c.get("/a", 11, 1)).toBeUndefined()
    expect(c.get("/a", 10, 2)).toBeUndefined()
    c.keepOnly(new Set(["/b"]))
    expect(c.get("/a", 10, 1)).toBeUndefined()
  })
})

describe("mapLimit", () => {
  it("runs at most `limit` at once, in order, a failure giving undefined", async () => {
    let running = 0
    let most = 0
    const out = await mapLimit([1, 2, 3, 4, 5], 2, async (n) => {
      running++
      most = Math.max(most, running)
      await new Promise((r) => setTimeout(r, 5))
      running--
      if (n === 3) throw new Error("bad")
      return n * 10
    })
    expect(out).toEqual([10, 20, undefined, 40, 50])
    expect(most).toBe(2)
  })
})

describe("jsonlFiles", () => {
  it("lists the .jsonl files directly in a folder, none if it's missing", async () => {
    fs.writeFileSync(path.join(dir, "a.jsonl"), "x")
    fs.writeFileSync(path.join(dir, "b.txt"), "x")
    fs.mkdirSync(path.join(dir, "c.jsonl"))
    expect((await jsonlFiles(dir)).map((f) => path.basename(f.file))).toEqual(["a.jsonl"])
    expect(await jsonlFiles(path.join(dir, "nope"))).toEqual([])
  })
})

describe("PastSessions", () => {
  const s = (o: Partial<PastSession> & { transcriptPath?: string }) => ({
    agent: "claude" as const,
    sessionId: "a",
    updatedAt: 1,
    ...o,
  })

  it("merges the agents, names the ones that failed, flags folders that are gone", async () => {
    const past = new PastSessions(async (d) =>
      d === "/gone" ? false : d === "/here" ? true : undefined,
    )
    const result = await past.list([
      {
        agent: "claude",
        history: {
          list: async () => [
            s({ cwd: "/here", updatedAt: 2, transcriptPath: "/t/a.jsonl" }),
            s({ sessionId: "b", cwd: "/gone" }),
          ],
        },
      },
      { agent: "codex", history: { list: () => Promise.reject(new Error("unreadable")) } },
    ])
    expect(result.failed).toEqual(["codex"])
    // The renderer never gets main's file paths.
    expect(result.sessions).toEqual([
      s({ cwd: "/here", updatedAt: 2 }),
      s({ sessionId: "b", cwd: "/gone", cwdGone: true }),
    ])
    // …main keeps them, for a resume.
    expect(past.find("claude", "a")).toMatchObject({ cwd: "/here", transcriptPath: "/t/a.jsonl" })
    expect(past.find("codex", "a")).toBeUndefined()
  })

  it("a folder it couldn't check in time stays resumable", async () => {
    const past = new PastSessions(async () => undefined)
    const result = await past.list([
      { agent: "claude", history: { list: async () => [s({ cwd: "/slow" })] } },
    ])
    expect(result.sessions[0]!.cwdGone).toBeUndefined()
  })

  it("remembers a session a search found, for a resume", () => {
    const past = new PastSessions(async () => true)
    past.remember(s({ sessionId: "old", cwd: "/w", transcriptPath: "/t/old.jsonl" }))
    expect(past.find("claude", "old")).toMatchObject({ transcriptPath: "/t/old.jsonl" })
  })

  it("a list asked for while one runs shares it", async () => {
    let reads = 0
    const history = {
      list: async () => {
        reads++
        await new Promise((r) => setTimeout(r, 10))
        return [s({})]
      },
    }
    const past = new PastSessions(async () => true)
    const [a, b] = await Promise.all([
      past.list([{ agent: "claude", history }]),
      past.list([{ agent: "claude", history }]),
    ])
    expect(a).toBe(b)
    expect(reads).toBe(1)
    await past.list([{ agent: "claude", history }])
    expect(reads).toBe(2) // finished: the next one reads again
  })
})

describe("within / parseLine", () => {
  it("answers in time, or undefined when late", async () => {
    expect(await within(Promise.resolve(1), 50)).toBe(1)
    expect(await within(new Promise((r) => setTimeout(() => r(1), 100)), 10)).toBeUndefined()
  })
  it("parses an object line, nothing else", () => {
    expect(parseLine('{"a":1}')).toEqual({ a: 1 })
    expect(parseLine("[1]")).toEqual([1]) // an array is an object: callers check fields
    expect(parseLine("1")).toBeUndefined()
    expect(parseLine("nope")).toBeUndefined()
  })
})
