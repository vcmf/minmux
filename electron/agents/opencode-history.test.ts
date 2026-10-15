// @vitest-environment node
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { opencodeHistory } from "./opencode-history"

// OpenCode 1.18's tables, as much of them as the reader uses.
const SCHEMA = `
  create table session (id text primary key, project_id text, parent_id text, slug text,
    directory text not null, title text not null, version text, time_created integer,
    time_updated integer not null, time_archived integer);
  create table message (id text primary key, session_id text not null, time_created integer,
    time_updated integer, data text not null);
  create table part (id text primary key, message_id text not null, session_id text not null,
    time_created integer, time_updated integer, data text not null);`

let dir: string
let file: string
let db: DatabaseSync
let seq = 0
const session = (
  id: string,
  o: { title?: string; dir?: string; at: number; parent?: string; archived?: number },
) =>
  db
    .prepare(
      "insert into session (id, parent_id, directory, title, time_updated, time_archived) values (?, ?, ?, ?, ?, ?)",
    )
    .run(
      id,
      o.parent ?? null,
      o.dir ?? "/w",
      o.title ?? "New session - 2026-10-15T10:00:00.000Z",
      o.at,
      o.archived ?? null,
    )
const say = (sid: string, role: "user" | "assistant", part: object) => {
  const mid = `msg_${++seq}`
  db.prepare("insert into message values (?, ?, ?, ?, ?)").run(
    mid,
    sid,
    seq,
    seq,
    JSON.stringify({ role }),
  )
  db.prepare("insert into part values (?, ?, ?, ?, ?, ?)").run(
    `prt_${seq}`,
    mid,
    sid,
    seq,
    seq,
    JSON.stringify(part),
  )
}
const text = (t: string, synthetic = false) => ({
  type: "text",
  text: t,
  ...(synthetic ? { synthetic } : {}),
})

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-hist-"))
  file = path.join(dir, "opencode.db")
  db = new DatabaseSync(file)
  db.exec(SCHEMA)
})
afterEach(() => {
  db.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

describe("opencodeHistory", () => {
  it("lists root sessions newest first, by title, else the first prompt the user typed", async () => {
    session("ses_a", { title: "Fix the quit drain", dir: "/w/term", at: 2000 })
    session("ses_b", { at: 3000 }) // OpenCode's placeholder title
    say("ses_b", "user", text("injected context", true))
    say("ses_b", "user", text("write the\nreadme"))
    session("ses_child", { title: "sub-agent", at: 4000, parent: "ses_a" })
    session("ses_old", { title: "archived", at: 5000, archived: 1 })
    session("ses_empty", { at: 6000 }) // no prompt, no title: not listed
    expect(await opencodeHistory(() => file).list()).toEqual([
      {
        agent: "opencode",
        sessionId: "ses_b",
        updatedAt: 3000,
        firstPrompt: "write the readme",
        cwd: "/w",
      },
      {
        agent: "opencode",
        sessionId: "ses_a",
        updatedAt: 2000,
        name: "Fix the quit drain",
        cwd: "/w/term",
      },
    ])
  })

  it("reads again only when the database changed", async () => {
    session("ses_a", { title: "one", at: 1 })
    const h = opencodeHistory(() => file)
    expect(await h.list()).toHaveLength(1)
    session("ses_b", { title: "two", at: 2 })
    expect(await h.list()).toHaveLength(2)
  })

  it("no database: nothing; a schema it doesn't know: it says so", async () => {
    expect(await opencodeHistory(() => path.join(dir, "none.db")).list()).toEqual([])
    db.exec("drop table part")
    await expect(opencodeHistory(() => file).list()).rejects.toThrow()
  })

  // Search: a checker for the query, asked one session at a time (as the worker does).
  const searchAll = (q: string, ids: string[]) => {
    const c = opencodeHistory(() => file).searcher(q)!
    try {
      return ids.flatMap((id) => {
        const h = c.check(id)
        return h ? [h] : []
      })
    } finally {
      c.close()
    }
  }

  it("searches what was written (text parts, not tools or OpenCode's own), ignoring case", () => {
    session("ses_a", { title: "a", at: 2000 })
    session("ses_b", { title: "b", at: 3000 })
    session("ses_c", { title: "c", at: 4000 })
    say("ses_a", "assistant", text("Done: the Quit Drain works"))
    say("ses_b", "assistant", { type: "tool", tool: "bash", state: { output: "quit drain" } })
    say("ses_c", "user", text("quit drain", true))
    const hits = searchAll("quit drain", ["ses_a", "ses_b", "ses_c"])
    expect(hits).toHaveLength(1)
    expect(hits[0]).toMatchObject({ agent: "opencode", sessionId: "ses_a" })
    expect(hits[0]!.snippet.slice(hits[0]!.match, hits[0]!.match + hits[0]!.length)).toBe(
      "Quit Drain",
    )
  })

  it("letters beyond ASCII ignore case too (no narrowing on them)", () => {
    session("ses_1", { title: "x", at: 1 })
    say("ses_1", "user", text("Über die Brücke"))
    expect(searchAll("ÜBER", ["ses_1"])).toHaveLength(1)
    expect(searchAll("brÜcke", ["ses_1"])).toHaveLength(1)
  })

  it("a query mixing languages narrows on its ASCII word and still matches the rest", () => {
    session("ses_1", { title: "x", at: 1 })
    say("ses_1", "user", text("日本語の説明 for the api"))
    expect(searchAll("日本語の説明 for the api", ["ses_1"])).toHaveLength(1)
    expect(searchAll("日本語の説明 nope", ["ses_1"])).toHaveLength(0)
  })

  it("no database: no checker; one it can't read throws (the tab says so)", () => {
    expect(opencodeHistory(() => path.join(dir, "none.db")).searcher("quit")).toBeNull()
    db.exec("drop table part")
    expect(() => opencodeHistory(() => file).searcher("quit")).toThrow()
  })

  it("says when a session was last active: its newest part, as its row lags during a turn", async () => {
    session("ses_a", { title: "a", at: 1234 })
    const h = opencodeHistory(() => file)
    expect(await h.touched("ses_a")).toBe(1234)
    say("ses_a", "assistant", text("streaming"))
    db.prepare("update part set time_updated = 9999 where session_id = 'ses_a'").run()
    expect(await h.touched("ses_a")).toBe(9999)
    expect((await h.list())[0]!.updatedAt).toBe(9999)
    expect(await h.touched("ses_none")).toBeUndefined()
  })
})
