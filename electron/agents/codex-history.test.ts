import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { codexHead, codexHistory, codexIndex } from "./codex-history"

const j = (o: unknown) => JSON.stringify(o)
const meta = (cwd: string) =>
  j({ type: "session_meta", payload: { id: "x", cwd, base_instructions: { text: "…" } } })
const msg = (role: string, text: string) =>
  j({
    type: "response_item",
    payload: { type: "message", role, content: [{ type: "input_text", text }] },
  })

describe("codexIndex", () => {
  it("keeps each thread's latest name and update time", () => {
    const text = [
      j({ id: "a", thread_name: "first", updated_at: "2026-10-01T10:00:00Z" }),
      j({ id: "b", thread_name: "other", updated_at: "garbage" }),
      j({ id: "a", thread_name: " renamed ", updated_at: "2026-10-02T10:00:00Z" }),
      "not json",
    ].join("\n")
    expect(codexIndex(text)).toEqual(
      new Map([
        ["a", { name: "renamed", updatedAt: Date.parse("2026-10-02T10:00:00Z") }],
        ["b", { name: "other", updatedAt: undefined }],
      ]),
    )
  })
})

describe("codexHead", () => {
  it("finds the folder and the first prompt past Codex's injected messages", () => {
    const head = [
      meta("/w/term"),
      msg("developer", "you are codex"),
      msg("user", "<environment_context>\n<cwd>/w/term</cwd>"),
      msg("user", "fix the\nquit drain"),
      msg("user", "later"),
    ].join("\n")
    expect(codexHead(head)).toEqual({ cwd: "/w/term", firstPrompt: "fix the quit drain" })
  })

  it("skips what Codex adds to a user turn: AGENTS.md, IDE context, image markers", () => {
    const agentsMd = msg("user", "# AGENTS.md instructions for /w/rts\n\n<INSTRUCTIONS>…")
    const ide = msg(
      "user",
      "# Context from my IDE setup:\n\n## Open tabs:\n- a.ts\n\n## My request for Codex:\nfix the\nbuild\n",
    )
    expect(codexHead([meta("/w"), agentsMd, ide].join("\n")).firstPrompt).toBe("fix the build")
    const img = j({
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: "<image name=[Image #1] path=x>" },
          { type: "input_text", text: "what is this" },
          { type: "input_text", text: "</image>" },
        ],
      },
    })
    expect(codexHead([meta("/w"), img].join("\n")).firstPrompt).toBe("what is this")
    // An IDE turn without a request: not a prompt.
    expect(
      codexHead([meta("/w"), msg("user", "# Context from my IDE setup:\n- a.ts")].join("\n"))
        .firstPrompt,
    ).toBeUndefined()
  })

  it("finds the folder in a session_meta line longer than the head", () => {
    const cut = meta("/w/big").slice(0, 60) // a line cut off mid-way
    expect(codexHead(cut).cwd).toBe("/w/big")
  })

  it("takes a user_message event too", () => {
    const head = [
      meta("/w"),
      j({ type: "event_msg", payload: { type: "user_message", message: "hi" } }),
    ]
    expect(codexHead(head.join("\n")).firstPrompt).toBe("hi")
  })
})

describe("codexHistory", () => {
  let home: string
  const id = (n: number) => `01a1000${n}-aaaa-7bbb-cccc-dddddddddddd`
  const rollout = (day: string, n: number, lines: string[], mtime: number) => {
    const dir = path.join(home, "sessions", ...day.split("/"))
    fs.mkdirSync(dir, { recursive: true })
    const f = path.join(dir, `rollout-2026-10-01T10-00-0${n}-${id(n)}.jsonl`)
    fs.writeFileSync(f, lines.join("\n") + "\n")
    fs.utimesSync(f, new Date(mtime), new Date(mtime))
  }
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "codex-hist-"))
  })
  afterEach(() => fs.rmSync(home, { recursive: true, force: true }))

  it("lists rollouts newest first, named by the index or the first prompt", async () => {
    rollout("2026/10/01", 1, [meta("/w/term"), msg("user", "fix the quit drain")], 1000)
    rollout("2026/10/02", 2, [meta("/w/other"), msg("user", "hello")], 2000)
    rollout("2026/10/02", 3, [meta("/w/empty")], 3000) // never prompted, never named: not listed
    fs.writeFileSync(
      path.join(home, "session_index.jsonl"),
      j({ id: id(2), thread_name: "readme", updated_at: new Date(5000).toISOString() }) + "\n",
    )
    fs.mkdirSync(path.join(home, "archived_sessions"))
    expect(await codexHistory(() => home).list()).toEqual([
      {
        agent: "codex",
        sessionId: id(2),
        updatedAt: 5000,
        name: "readme",
        firstPrompt: "hello",
        cwd: "/w/other",
        transcriptPath: expect.stringContaining(id(2)),
      },
      {
        agent: "codex",
        sessionId: id(1),
        updatedAt: 1000,
        firstPrompt: "fix the quit drain",
        cwd: "/w/term",
        transcriptPath: expect.stringContaining(id(1)),
      },
    ])
  })

  it("lists a session whose first prompt is past the head (a big AGENTS.md), untitled", async () => {
    const big = msg("user", "<user_instructions>" + "x".repeat(140 * 1024))
    rollout("2026/10/01", 1, [meta("/w/term"), big, msg("user", "the prompt")], 1000)
    const rows = await codexHistory(() => home).list()
    expect(rows).toEqual([expect.objectContaining({ sessionId: id(1), cwd: "/w/term" })])
    expect(rows[0]!.firstPrompt).toBeUndefined()
  })

  it("no Codex folder: nothing", async () => {
    expect(await codexHistory(() => path.join(home, "nope")).list()).toEqual([])
  })
})
