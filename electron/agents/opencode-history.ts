// OpenCode's past sessions for the Sessions tab: its SQLite database (`<data>/opencode/opencode.db`,
// OpenCode 1.18), opened read-only with node:sqlite in the sessions worker (never main: queries
// are synchronous). A schema OpenCode changed makes a query throw: the tab says it couldn't read
// OpenCode's sessions, the other agents still list.

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"
import { LIST_MAX, oneLine } from "../../src/lib/past-sessions"
import { longestWord, matcher, onDisk, snippetOf } from "../session-search"
import { isDefaultTitle } from "./opencode-names"
import type { ListedSession, OwnSearch, SessionHistory } from "./types"

/** OpenCode's database (XDG data dir, as OpenCode resolves it). */
export const opencodeDb = (): string =>
  path.join(
    process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"),
    "opencode",
    "opencode.db",
  )

// Root sessions (sub-agents are child sessions), not archived; with the first text the user typed
// (a synthetic part is OpenCode's, not theirs).
// The newest LIST_MAX by the session row's time are picked first, so the per-session work below
// runs for those only. (The row lags its parts only within a turn: an active session would need
// LIST_MAX others updated since its last prompt to be cut.)
const LIST_SQL = `
  select s.id, s.title, s.directory,
    max(coalesce((select max(time_updated) from part where session_id = s.id), 0),
      s.time_updated) as updated,
    (select json_extract(p.data, '$.text') from part p join message m on m.id = p.message_id
      where p.session_id = s.id and json_extract(m.data, '$.role') = 'user'
        and json_extract(p.data, '$.type') = 'text'
        and coalesce(json_extract(p.data, '$.synthetic'), 0) = 0
      order by p.time_created, p.id limit 1) as first
  from (select id, title, directory, time_updated from session
        where parent_id is null and time_archived is null
        order by time_updated desc limit ${LIST_MAX}) s
  order by updated desc`

// One session's written text (text parts that aren't OpenCode's own), oldest first, by the
// part_session_idx index. `like` narrows on the query's longest word when it's ASCII (SQLite folds
// ASCII case only); every row is still checked with the shared matcher.
const PARTS_SQL = (narrow: boolean) => `
  select json_extract(data, '$.text') as text from part
  where session_id = ? and json_extract(data, '$.type') = 'text'
    and coalesce(json_extract(data, '$.synthetic'), 0) = 0
    ${narrow ? "and data like ? escape '\\'" : ""}
  order by time_created`

// A session's last activity: its row lags during a turn, its newest part doesn't.
const TOUCHED_SQL = `
  select max(coalesce((select max(time_updated) from part where session_id = s.id), 0),
    s.time_updated) as t
  from session s where s.id = ?`

type ListRow = {
  id: string
  title: string
  directory: string
  updated: number
  first: string | null
}

/** A `like` pattern for `word` anywhere (its wildcards taken as text). */
const likeAnywhere = (word: string) => `%${word.replace(/[\\%_]/g, "\\$&")}%`

const BUSY_WAIT_MS = 1000

/** Open, run, close: OpenCode keeps writing it, so it's never held open between reads. */
function withDb<T>(file: string, read: (db: DatabaseSync) => T): T {
  // OpenCode may hold a lock for a moment (a checkpoint): wait for it rather than fail.
  const db = new DatabaseSync(file, { readOnly: true, timeout: BUSY_WAIT_MS })
  try {
    return read(db)
  } finally {
    db.close()
  }
}

/** The listing's rows from the database's. */
export function opencodeRows(rows: ListRow[]): ListedSession[] {
  return rows.flatMap((r) => {
    const name = r.title && !isDefaultTitle(r.title) ? oneLine(r.title) : undefined
    const firstPrompt = r.first ? oneLine(r.first) : undefined
    if (!name && !firstPrompt) return [] // opened and closed without a prompt
    return [
      {
        agent: "opencode" as const,
        sessionId: r.id,
        updatedAt: r.updated,
        ...(name ? { name } : {}),
        ...(firstPrompt ? { firstPrompt } : {}),
        ...(r.directory ? { cwd: r.directory } : {}),
      },
    ]
  })
}

/** OpenCode's sessions, newest first, and its own search (`file` = its database). */
export function opencodeHistory(file = opencodeDb): SessionHistory & OwnSearch {
  let cached: { key: string; rows: ListedSession[] } | null = null
  // The database and its write-ahead log: either changing means new rows.
  const stamp = () =>
    [file(), `${file()}-wal`]
      .map((f) => {
        try {
          const st = fs.statSync(f)
          return `${st.size}:${st.mtimeMs}`
        } catch {
          return "-"
        }
      })
      .join("|")
  return {
    async list() {
      if (!fs.existsSync(file())) return [] // OpenCode never ran here
      const key = stamp()
      if (cached?.key === key) return cached.rows
      const rows = opencodeRows(withDb(file(), (db) => db.prepare(LIST_SQL).all() as ListRow[]))
      cached = { key, rows }
      return rows
    },

    searcher(query) {
      if (!fs.existsSync(file())) return null
      // SQLite's `like` folds ASCII case only: narrow on the longest ASCII word, if any.
      const longest = longestWord(query, /^[\x20-\x7e]+$/)
      const narrow = longest !== ""
      const re = matcher(query)
      const db = new DatabaseSync(file(), { readOnly: true, timeout: BUSY_WAIT_MS })
      try {
        const stmt = db.prepare(PARTS_SQL(narrow))
        // The data column is JSON: the word as written there (quotes escaped).
        const like = likeAnywhere(onDisk(longest))
        return {
          check(sessionId) {
            const rows = (
              narrow ? stmt.iterate(sessionId, like) : stmt.iterate(sessionId)
            ) as Iterable<{
              text: string | null
            }>
            for (const r of rows) {
              const s = r.text ? snippetOf(r.text, re) : undefined
              if (s) return { agent: "opencode", sessionId, ...s }
            }
            return undefined
          },
          close: () => db.close(),
        }
      } catch (e) {
        db.close()
        throw e
      }
    },

    async touched(sessionId) {
      if (!fs.existsSync(file())) return undefined
      const r = withDb(file(), (db) => db.prepare(TOUCHED_SQL).get(sessionId)) as
        { t?: number | null } | undefined
      return typeof r?.t === "number" ? r.t : undefined
    },
  }
}
