// An OpenCode session as chat items (the phone's chat view), from its SQLite database opened
// read-only (in the remote-host worker, never main: queries are synchronous). Parts update in
// place (a tool's status), so each read takes the session's newest parts again and upserts them
// by part id. A schema OpenCode changed makes a query throw: the pane says Chat view is unavailable.

import { DatabaseSync } from "node:sqlite"
import { clip, questionsOf, RESULT_MAX, TEXT_MAX, type ChatItem } from "../../src/lib/remote-chat"
import { ChatLog, type ChatReader } from "./chat-log"
import { toolSummary } from "./claude-chat"
import { opencodeDb } from "./opencode-history"

const TAIL = 300 // parts read per refresh (the latest ones)

const PARTS_SQL = `
  select p.id, p.data, json_extract(m.data, '$.role') as role from part p
  join message m on m.id = p.message_id
  where p.session_id = ?
  order by p.time_created desc, p.id desc limit ${TAIL}`

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
  private db: DatabaseSync | null = null
  private seen = new Map<string, string>() // part id → its data (only changed parts are resent)

  constructor(
    private readonly sessionId: string,
    private readonly file = opencodeDb(),
  ) {}

  async read(): Promise<ChatItem[]> {
    this.db ??= new DatabaseSync(this.file, { readOnly: true })
    const rows = (this.db.prepare(PARTS_SQL).all(this.sessionId) as Row[]).reverse()
    for (const r of rows) {
      if (this.seen.get(r.id) === r.data) continue
      this.seen.set(r.id, r.data)
      const item = opencodeItem(r)
      if (item) this.log.upsert(item)
    }
    return this.log.takeChanged()
  }

  close(): void {
    this.db?.close()
    this.db = null
  }
}

export const opencodeChat = (sessionId: string): ChatReader => new OpenCodeChat(sessionId)
