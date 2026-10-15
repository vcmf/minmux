import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { claudeHead, claudeHistory, claudeNames } from "./claude-history"

const j = (o: unknown) => JSON.stringify(o)
const user = (content: unknown, more: object = {}) =>
  j({ type: "user", cwd: "/w/term", message: { role: "user", content }, ...more })

describe("claudeHead", () => {
  it("finds the folder and the first prompt the user typed", () => {
    const head = [
      j({ type: "permission-mode", permissionMode: "default" }),
      user("<command-name>/clear</command-name>"),
      user("injected", { isMeta: true }),
      user("sub-agent's", { isSidechain: true }),
      user([{ type: "tool_result", content: "x" }]),
      user([{ type: "text", text: "fix the\nquit drain" }]),
      user("later prompt"),
    ].join("\n")
    expect(claudeHead(head)).toEqual({ cwd: "/w/term", firstPrompt: "fix the quit drain" })
  })

  it("with its path, takes the folder Claude files the session under", () => {
    const head = [
      j({ type: "system", cwd: "/tmp/scratch" }), // a nested claude's folder first
      user("hello"),
    ].join("\n")
    expect(claudeHead(head, "/h/.claude/projects/-w-term/x.jsonl").cwd).toBe("/w/term")
    expect(claudeHead(head).cwd).toBe("/tmp/scratch") // no path: the first one
    // None fits: the first, and resume says its folder doesn't match.
    expect(claudeHead(head, "/h/.claude/projects/-elsewhere/x.jsonl").cwd).toBe("/tmp/scratch")
  })

  it("skips junk lines and says nothing it didn't find", () => {
    expect(claudeHead("not json\n{\n")).toEqual({ cwd: undefined, firstPrompt: undefined })
  })
})

describe("claudeNames", () => {
  it("takes the latest /rename and the last typed prompt", () => {
    const text = [
      j({ type: "custom-title", customTitle: "first name" }),
      j({ type: "last-prompt", lastPrompt: "older" }),
      j({ type: "custom-title", customTitle: "  quit drain  " }),
      j({ type: "last-prompt", lastPrompt: "<command-name>/exit</command-name>" }),
      j({ type: "last-prompt", lastPrompt: "ship it" }),
    ].join("\n")
    expect(claudeNames(text)).toEqual({ name: "quit drain", lastPrompt: "ship it" })
  })
})

describe("claudeHistory", () => {
  let root: string
  const id = (n: number) => `0000000${n}-aaaa-bbbb-cccc-dddddddddddd`
  const write = (dir: string, name: string, lines: string[]) => {
    fs.mkdirSync(path.join(root, "projects", dir), { recursive: true })
    const f = path.join(root, "projects", dir, name)
    fs.writeFileSync(f, lines.join("\n") + "\n")
    return f
  }
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "claude-hist-"))
  })
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

  it("lists each session newest first, by name or first prompt, with its folder", async () => {
    const a = write("-w-term", `${id(1)}.jsonl`, [user("fix the quit drain")])
    const b = write("-w-other", `${id(2)}.jsonl`, [
      user("hello"),
      j({ type: "custom-title", customTitle: "readme" }),
    ])
    fs.utimesSync(a, new Date(1000), new Date(1000))
    fs.utimesSync(b, new Date(2000), new Date(2000))
    write("-w-term", "agent-1234.jsonl", [user("old sub-agent file")]) // not a session id
    write(path.join("-w-term", id(1), "subagents"), `${id(3)}.jsonl`, [user("sub-agent")])
    write("-w-term", `${id(4)}.jsonl`, [user("<command-name>/clear</command-name>")]) // no prompt
    const rows = await claudeHistory(() => root).list()
    expect(rows).toEqual([
      {
        agent: "claude",
        sessionId: id(2),
        updatedAt: 2000,
        name: "readme",
        firstPrompt: "hello",
        cwd: "/w/term",
        transcriptPath: b,
      },
      {
        agent: "claude",
        sessionId: id(1),
        updatedAt: 1000,
        firstPrompt: "fix the quit drain",
        cwd: "/w/term",
        transcriptPath: a,
      },
    ])
  })

  it("reads a changed transcript again, and only then", async () => {
    const f = write("-w-term", `${id(1)}.jsonl`, [user("first")])
    const h = claudeHistory(() => root)
    expect((await h.list())[0]!.name).toBeUndefined()
    fs.appendFileSync(f, j({ type: "custom-title", customTitle: "renamed" }) + "\n")
    expect((await h.list())[0]!.name).toBe("renamed")
  })

  it("finds the rename in the tail of a big transcript", async () => {
    const filler = user("x".repeat(1000)).replace('"type":"user"', '"type":"assistant"')
    write("-w-term", `${id(1)}.jsonl`, [
      user("start"),
      ...Array(200).fill(filler), // ~200 KB: head and tail don't overlap
      j({ type: "custom-title", customTitle: "late name" }),
    ])
    expect((await claudeHistory(() => root).list())[0]).toMatchObject({
      name: "late name",
      firstPrompt: "start",
    })
  })

  it("no Claude folder: nothing", async () => {
    expect(await claudeHistory(() => path.join(root, "nope")).list()).toEqual([])
  })
})
