// @vitest-environment node
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"
import { describe, expect, it } from "vitest"
import { chatReaderFor } from "./chat"
import { ChatLog, FIRST_READ_MAX, JsonlChat, MAX_ITEMS } from "./chat-log"
import { claudeChat, toolSummary } from "./claude-chat"
import { codexChat } from "./codex-chat"
import { OpenCodeChat, opencodeItem } from "./opencode-chat"

const tmp = (name: string) => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "chat-")), name)
const line = (o: unknown) => JSON.stringify(o) + "\n"

describe("Claude transcript", () => {
  it("user, reply, tool + result, question + answer; skips meta, sidechains and injected text", async () => {
    const f = tmp("c.jsonl")
    fs.writeFileSync(
      f,
      line({
        type: "user",
        uuid: "u0",
        message: { content: "<command-name>/clear</command-name>" },
      }) +
        line({ type: "user", uuid: "u1", message: { content: "fix it" } }) +
        line({
          type: "user",
          uuid: "int",
          message: { content: [{ type: "text", text: "[Request interrupted by user]" }] },
        }) +
        line({ type: "user", uuid: "m", isMeta: true, message: { content: "meta" } }) +
        line({
          type: "assistant",
          uuid: "s",
          isSidechain: true,
          message: { content: [{ type: "text", text: "sub" }] },
        }) +
        line({
          type: "assistant",
          uuid: "a1",
          message: {
            content: [
              { type: "thinking", thinking: "" },
              { type: "text", text: "On it." },
            ],
          },
        }) +
        line({
          type: "assistant",
          uuid: "a2",
          message: {
            content: [{ type: "tool_use", id: "t1", name: "Edit", input: { file_path: "/a.ts" } }],
          },
        }) +
        line({
          type: "user",
          uuid: "r1",
          message: {
            content: [
              {
                type: "tool_result",
                tool_use_id: "t1",
                is_error: true,
                content: [{ type: "text", text: "no such file" }],
              },
            ],
          },
        }) +
        line({
          type: "assistant",
          uuid: "a3",
          message: {
            content: [
              {
                type: "tool_use",
                id: "q1",
                name: "AskUserQuestion",
                input: {
                  questions: [
                    {
                      question: "Which?",
                      multiSelect: false,
                      options: [{ label: "A" }, { label: "B", description: "bee" }],
                    },
                  ],
                },
              },
            ],
          },
        }) +
        "{not json\n",
    )
    const r = claudeChat(["/nope", f])
    const items = await r.read()
    expect(items.map((i) => i.kind)).toEqual(["user", "assistant", "tool", "question"])
    expect(items[2]).toMatchObject({
      name: "Edit",
      summary: "/a.ts",
      result: "no such file",
      error: true,
    })
    expect(items[3]).toMatchObject({
      questions: [
        {
          question: "Which?",
          multi: false,
          options: [{ label: "A" }, { label: "B", description: "bee" }],
        },
      ],
    })
    fs.appendFileSync(
      f,
      line({
        type: "user",
        uuid: "r2",
        message: { content: [{ type: "tool_result", tool_use_id: "q1", content: "A" }] },
      }),
    )
    const next = await r.read()
    expect(next).toEqual([expect.objectContaining({ kind: "question", answer: "A" })])
    expect(await r.read()).toEqual([])
  })

  it("a line written in two parts, and a character split across reads", async () => {
    const f = tmp("c.jsonl")
    const whole = line({ type: "user", uuid: "u", message: { content: "héllo wörld ✓" } })
    fs.writeFileSync(f, whole.slice(0, 20))
    const r = claudeChat([f])
    expect(await r.read()).toEqual([])
    fs.appendFileSync(f, whole.slice(20))
    expect(await r.read()).toEqual([{ id: "u", kind: "user", text: "héllo wörld ✓", seq: 1 }])
  })

  it("summaries", () => {
    expect(toolSummary("Bash", { command: "ls\npwd" })).toBe("ls")
    expect(toolSummary("Grep", { pattern: "x" })).toBe("x")
    expect(toolSummary("Weird", {})).toBe("Weird")
    expect(toolSummary("Long", { command: "a".repeat(300) })).toHaveLength(201)
  })

  it("no file yet: nothing", async () => {
    expect(await claudeChat(["/does/not/exist"]).read()).toEqual([])
  })
})

describe("Codex rollout", () => {
  it("typed user text, replies, calls with outputs, request_user_input", async () => {
    const f = tmp("rollout.jsonl")
    const ri = (payload: unknown) => line({ type: "response_item", payload })
    fs.writeFileSync(
      f,
      line({ type: "session_meta", payload: {} }) +
        ri({
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "# AGENTS.md instructions for /x" }],
        }) +
        ri({
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "add a test" }],
        }) +
        ri({ type: "message", role: "developer", content: [{ type: "input_text", text: "dev" }] }) +
        ri({
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Sure." }],
        }) +
        ri({
          type: "function_call",
          id: "fc1",
          name: "shell",
          arguments: '{"command":"npm test"}',
          call_id: "c1",
        }) +
        ri({ type: "function_call_output", call_id: "c1", output: "ok" }) +
        ri({
          type: "custom_tool_call",
          id: "ct1",
          name: "exec",
          input: 'text(await tools.exec_command({cmd:"cat \\"a b\\""}))',
          call_id: "c2",
        }) +
        ri({
          type: "custom_tool_call_output",
          call_id: "c2",
          output: [{ type: "input_text", text: "done" }],
        }) +
        ri({
          type: "function_call",
          id: "fc3",
          name: "request_user_input",
          arguments: JSON.stringify({
            questions: [{ id: "q", header: "H", question: "Pick", options: [{ label: "X" }] }],
          }),
          call_id: "c3",
        }) +
        ri({ type: "function_call_output", call_id: "c3", output: "X" }),
    )
    const items = await codexChat([f]).read()
    expect(items.map((i) => i.kind)).toEqual(["user", "assistant", "tool", "tool", "question"])
    expect(items[0]).toMatchObject({ text: "add a test" })
    expect(items[2]).toMatchObject({ name: "shell", summary: "npm test", result: "ok" })
    expect(items[3]).toMatchObject({ name: "exec", summary: 'cat "a b"', result: "done" })
    expect(items[4]).toMatchObject({ questions: [{ header: "H", question: "Pick" }], answer: "X" })
  })
})

describe("OpenCode database", () => {
  it("text by role, tools with status, question tool; re-reads only changed parts", async () => {
    const file = tmp("opencode.db")
    const db = new DatabaseSync(file)
    db.exec(`create table message (id text primary key, session_id text, time_created integer, time_updated integer, data text);
      create table part (id text primary key, message_id text, session_id text, time_created integer, time_updated integer, data text);`)
    const msg = db.prepare("insert into message values (?, 's1', ?, ?, ?)")
    const part = db.prepare("insert or replace into part values (?, ?, 's1', ?, ?, ?)")
    msg.run("m1", 1, 1, JSON.stringify({ role: "user" }))
    msg.run("m2", 2, 2, JSON.stringify({ role: "assistant" }))
    part.run("p1", "m1", 1, 1, JSON.stringify({ type: "text", text: "hello" }))
    part.run("p0", "m1", 1, 1, JSON.stringify({ type: "text", text: "sys", synthetic: true }))
    part.run("p2", "m2", 2, 2, JSON.stringify({ type: "text", text: "hi" }))
    part.run(
      "p3",
      "m2",
      3,
      3,
      JSON.stringify({
        type: "tool",
        tool: "bash",
        state: { status: "running", input: { command: "ls" } },
      }),
    )
    part.run("p4", "m2", 4, 4, JSON.stringify({ type: "step-start" }))
    const r = new OpenCodeChat("s1", file)
    const first = await r.read()
    expect(first.map((i) => i.kind)).toEqual(["user", "assistant", "tool"])
    part.run(
      "p3",
      "m2",
      3,
      5,
      JSON.stringify({
        type: "tool",
        tool: "bash",
        state: { status: "error", input: { command: "ls" }, error: "boom" },
      }),
    )
    expect(await r.read()).toEqual([
      { id: "p3", kind: "tool", name: "bash", summary: "ls", result: "boom", error: true, seq: 3 },
    ])
    expect(await r.read()).toEqual([])
    r.close()
    db.close()
    expect(
      opencodeItem({
        id: "q",
        role: "assistant",
        data: JSON.stringify({
          type: "tool",
          tool: "question",
          state: { input: { questions: [{ question: "Q?", options: [] }] }, output: "yes" },
        }),
      }),
    ).toMatchObject({ kind: "question", answer: "yes" })
    expect(opencodeItem({ id: "x", role: null, data: "{bad" })).toBeNull()
  })
})

describe("OpenCode backoff", () => {
  it("after a failed read, waits before trying again", async () => {
    const r = new OpenCodeChat("s", "/no/such/opencode.db")
    await expect(r.read()).rejects.toThrow()
    expect(await r.read()).toEqual([]) // within the backoff: no new try, no error
  })
})

describe("chat log and dispatch", () => {
  it("keeps the newest items", () => {
    const log = new ChatLog()
    for (let i = 0; i < MAX_ITEMS + 5; i++) log.upsert({ id: String(i), kind: "user", text: "x" })
    log.calls.set("old", "0")
    log.takeChanged()
    expect(log.items).toHaveLength(MAX_ITEMS)
    expect(log.items[0]!.id).toBe("5")
    expect(log.calls.has("old")).toBe(false)
  })

  it("a rewritten transcript is read again from the start", async () => {
    const f = tmp("c.jsonl")
    fs.writeFileSync(
      f,
      line({ type: "user", uuid: "a", message: { content: "first version, long" } }),
    )
    const r = new JsonlChat([f], (o, log) =>
      log.upsert({ id: String(o.uuid), kind: "user", text: "x" }),
    )
    await r.read()
    fs.writeFileSync(f, line({ type: "user", uuid: "b", message: { content: "x" } }))
    expect((await r.read()).map((i) => i.id)).toEqual(["b"])
  })

  it("a huge transcript is read from near its end; an overlong line is skipped", async () => {
    const f = tmp("big.jsonl")
    const pad = "x".repeat(1024)
    const fd = fs.openSync(f, "w")
    for (let i = 0; i < 17 * 1024; i++) fs.writeSync(fd, line({ uuid: `old${i}`, pad }))
    fs.writeSync(fd, line({ uuid: "newest", pad }))
    fs.closeSync(fd)
    const seen: string[] = []
    const r = new JsonlChat([f], (o, log) => {
      seen.push(String(o.uuid))
      log.upsert({ id: String(o.uuid), kind: "user", text: "x" })
    })
    await r.read()
    expect(seen.at(-1)).toBe("newest")
    expect(seen).not.toContain("old0") // the first MBs were never read
    expect(seen.length).toBeLessThan(17 * 1024)
    expect(r.log.items.length).toBeLessThanOrEqual(MAX_ITEMS)

    fs.appendFileSync(
      f,
      JSON.stringify({ uuid: "huge", pad: "y".repeat(9 * 1024 * 1024) }) +
        "\n" +
        line({ uuid: "after", pad }),
    )
    await r.read()
    expect(seen).not.toContain("huge")
    expect(seen.at(-1)).toBe("after")
  }, 30_000)

  it("a first read that starts exactly at a line start keeps that line", async () => {
    const f = tmp("edge.jsonl")
    const big = line({ uuid: "pad", pad: "p".repeat(FIRST_READ_MAX) }) // ends with a newline
    const keep = line({ uuid: "first-kept" })
    // The read starts FIRST_READ_MAX before the end: right after the padding line's newline.
    const rest = "x".repeat(FIRST_READ_MAX - keep.length - 1) + "\n"
    fs.writeFileSync(f, big + keep + rest)
    const seen: string[] = []
    const r = new JsonlChat([f], (o) => void seen.push(String(o.uuid)))
    await r.read()
    expect(seen[0]).toBe("first-kept")
  }, 30_000)

  it("picks a reader per agent", () => {
    expect(chatReaderFor({ agent: "claude", sessionId: "s", files: ["/f"] })).not.toBeNull()
    expect(chatReaderFor({ agent: "claude", sessionId: "s", files: [] })).toBeNull()
    expect(chatReaderFor({ agent: "codex", sessionId: "s", files: ["/f"] })).not.toBeNull()
    expect(chatReaderFor({ agent: "opencode", sessionId: "s", files: [] })).not.toBeNull()
  })
})
