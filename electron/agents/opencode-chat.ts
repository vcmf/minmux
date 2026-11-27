// An OpenCode session as chat items (the phone's chat view), from its SQLite database opened
// read-only (in the remote-host worker, never main: queries are synchronous). Parts update in
// place (a tool's status), so each read takes the session's newest parts again and upserts them
// by part id. A schema OpenCode changed makes a query throw: the pane says Chat view is unavailable.

import { DatabaseSync } from "node:sqlite"
import { clip, RESULT_MAX, TEXT_MAX, type ChatItem } from "../../src/lib/remote-chat"
import { questionsOf } from "./questions"
import { ChatLog, type ChatReader } from "./chat-log"
import { toolSummary } from "./claude-chat"
import { opencodeDb } from "./opencode-history"

const CHAT_BUSY_WAIT_MS = 150

const TAIL = 300 // parts read per refresh (the latest ones)

// The newest parts' ids and update times (cheap), then the data of the ones that changed only.
const RECENT_SQL = `
  select id, time_updated as t from part where session_id = ?
  order by time_created desc, id desc limit ${TAIL}`
// All the changed parts' data in one query (ids as a JSON array).
const DATA_SQL = `
  select p.id, p.data, json_extract(m.data, '$.role') as role from part p
  join message m on m.id = p.message_id
  where p.id in (select value from json_each(?))`

type Row = { id: string; data: string; role: string | null }

const str = (v: unknown): string => (typeof v === "string" ? v : "")

/** One part as an item, or null for parts the chat doesn't show (steps, reasoning, patches). */
export function opencodeItem(row: Row): ChatItem | null {
  let d: Record<string, unknown>
  try {
    d = JSON.parse(row.data) as Record<string, unknown>
  } catch {
    return null
  }
  if (d.type === "text") {
    if (d.synthetic === true || !str(d.text).trim()) return null
    const kind = row.role === "user" ? "user" : "assistant"
    return { id: row.id, kind, text: clip(str(d.text), TEXT_MAX) }
  }
  if (d.type === "tool") {
    const name = str(d.tool)
    const state = (d.state ?? {}) as Record<string, unknown>
    const questions = name === "question" ? questionsOf(state.input) : null
    const output = str(state.output) || str(state.error)
    if (questions)
      return output
        ? { id: row.id, kind: "question", questions, answer: clip(output, RESULT_MAX) }
        : { id: row.id, kind: "question", questions }
    return {
      id: row.id,
      kind: "tool",
      name,
      summary: toolSummary(name, state.input),
      ...(output ? { result: clip(output, RESULT_MAX) } : {}),
      ...(state.status === "error" ? { error: true } : {}),
    }
  }
  return null
}

export class OpenCodeChat implements ChatReader {
  readonly log = new ChatLog()
  private seen = new Map<string, number>() // part id → its time_updated (changed parts only)

  constructor(
    private readonly sessionId: string,
    private readonly file = opencodeDb(),
  ) {}

  private retryAt = 0
  private fails = 0

  async read(): Promise<ChatItem[]> {
    // After a failed read (OpenCode held a lock), wait a while: each try may block the worker
    // that also serves the phones for up to the busy wait.
    if (Date.now() < this.retryAt) return []
    // Open, read, close (OpenCode keeps writing it, like opencode-history).
    // A short wait: this runs in the worker that also serves the phones; a lock still held is
    // just tried again on the next poll.
    let db: DatabaseSync | null = null
    try {
      db = new DatabaseSync(this.file, { readOnly: true, timeout: CHAT_BUSY_WAIT_MS })
      this.readFrom(db)
      this.fails = 0
    } catch (e) {
      this.retryAt = Date.now() + Math.min(8000, 500 * 2 ** this.fails++)
      throw e
    } finally {
      db?.close()
    }
    return this.log.takeChanged()
  }

  private readFrom(db: DatabaseSync): void {
    const recent = (
      db.prepare(RECENT_SQL).all(this.sessionId) as { id: string; t: number }[]
    ).reverse()
    const keep = new Map(recent.map(({ id, t }) => [id, t]))
    const changed = recent.filter(({ id, t }) => this.seen.get(id) !== t).map(({ id }) => id)
    if (changed.length) {
      const rows = new Map(
        (db.prepare(DATA_SQL).all(JSON.stringify(changed)) as Row[]).map((r) => [r.id, r]),
      )
      for (const id of changed) {
        const row = rows.get(id)
        const item = row ? opencodeItem(row) : null
        if (item) this.log.upsert(item)
      }
    }
    // Only now: a read that failed (a lock) leaves these parts to be read again next time.
    this.seen = keep // the parts still among the newest
  }

  close(): void {}
}

export const opencodeChat = (sessionId: string): ChatReader => new OpenCodeChat(sessionId)
