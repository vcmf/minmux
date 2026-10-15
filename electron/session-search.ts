// Searching past sessions' conversations for exact words, ignoring case (docs/design/
// AGENT_SESSIONS.md). Runs in the sessions worker, never main. `rg` finds candidate lines fast; each
// is parsed and counts only if the words are in what the user or the agent wrote (never tool
// output, file contents or JSON keys). Without `rg`, the files are streamed line by line.

import { spawn } from "node:child_process"
import fs from "node:fs"
import readline from "node:readline"
import type { AgentKind } from "../src/lib/agent-graph"
import { MIN_QUERY, type SessionHit } from "../src/lib/past-sessions"
import { parseLine } from "./history-read"

/** A session to search: its transcript file, or (no file) its agent's own store. */
export interface SearchFile {
  agent: AgentKind
  sessionId: string
  file?: string
}

export interface SearchOptions {
  texts: (agent: AgentKind, line: Record<string, unknown>) => string[] // what was written
  /** Could this raw line hold what was written at all? (skips parsing tool output) */
  quick?: (agent: AgentKind, line: string) => boolean
  onHit: (hit: SessionHit) => void
  signal: AbortSignal
  rg?: string | null // its path; none: stream the files
  max?: number // stop after this many sessions
  /** A session with no file, checked in its agent's store (synchronous: a store query). */
  own?: (f: SearchFile) => SessionHit | undefined
}

const yieldNow = () => new Promise((r) => setImmediate(r))

export const MAX_HITS = 50
const RG_BATCH = 200 // transcript paths per rg run
const AROUND = 60 // characters of context each side of the match

const esc = (t: string) => t.replace(/[.*+?^${}()|[\]\\/-]/g, "\\$&")
// With the `u` flag only syntax characters may be escaped (`\-` is an error there).
const escU = (t: string) => t.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")
/** A query's words (any whitespace between them matches any whitespace in the text). */
export const words = (query: string): string[] => query.trim().split(/\s+/).filter(Boolean)

/** A query's longest word (of those `only` allows; "" if none): what a prefilter narrows on. */
export const longestWord = (query: string, only?: RegExp): string =>
  words(query)
    .filter((w) => !only || only.test(w))
    .reduce((a, b) => (b.length > a.length ? b : a), "")

/** The query as it appears inside a JSON string on disk (quotes and backslashes escaped). */
export const onDisk = (query: string): string => JSON.stringify(query).slice(1, -1)

/** The query as a pattern over written text: its words, any whitespace between them. */
export const matcher = (query: string): RegExp =>
  new RegExp(words(query).map(escU).join("\\s+"), "iu")

/** The match in `text` with some words around it, on one line, or undefined. */
export function snippetOf(
  text: string,
  query: string | RegExp,
): Omit<SessionHit, "agent" | "sessionId"> | undefined {
  // On the text as written (lowercasing can change its length: "İ").
  const m = (typeof query === "string" ? matcher(query) : query).exec(text)
  if (!m) return undefined
  const flat = (t: string) => t.replace(/\s+/g, " ")
  let from = Math.max(0, m.index - AROUND)
  let to = Math.min(text.length, m.index + m[0].length + AROUND)
  // Never half an emoji (a surrogate pair) at either end.
  if (from > 0 && /[\uDC00-\uDFFF]/.test(text[from]!)) from--
  if (to < text.length && /[\uD800-\uDBFF]/.test(text[to - 1]!)) to++
  const lead = from > 0 ? "…" : ""
  const before = flat(text.slice(from, m.index))
  const match = flat(m[0])
  return {
    snippet: `${lead}${before}${match}${flat(text.slice(m.index + m[0].length, to))}${to < text.length ? "…" : ""}`,
    match: lead.length + before.length,
    length: match.length,
  }
}

/** A candidate line → a hit, if the words are in what was written on it. */
export function verify(
  f: SearchFile,
  line: string,
  query: string | RegExp,
  texts: SearchOptions["texts"],
  quick?: SearchOptions["quick"],
): SessionHit | undefined {
  if (quick && !quick(f.agent, line)) return undefined
  const o = parseLine(line)
  if (!o) return undefined
  const re = typeof query === "string" ? matcher(query) : query
  for (const t of texts(f.agent, o)) {
    const s = snippetOf(t, re)
    if (s) return { agent: f.agent, sessionId: f.sessionId, ...s }
  }
  return undefined
}

/** Search `files` (newest first) for `query`; hits arrive through `onHit`, one per session. */
export async function searchFiles(
  files: SearchFile[],
  query: string,
  o: SearchOptions,
): Promise<{ capped: boolean }> {
  const max = o.max ?? MAX_HITS
  const q = query.trim()
  if (max <= 0) return { capped: true }
  if (q.length < MIN_QUERY || files.length === 0 || o.signal.aborted) return { capped: false }
  // `rg` only narrows the files (those with the words anywhere); each is then checked here,
  // newest first, so the sessions shown are always the newest that match. If rg fails, every
  // file is checked.
  const longest = longestWord(q)
  const onDiskFiles = files.filter((f): f is SearchFile & { file: string } => !!f.file)
  const candidates = o.rg ? await withWords(o.rg, onDiskFiles, longest, o.signal) : null
  const pattern = bytePattern(q)
  const re = matcher(q) // compiled once, not per line
  let found = 0
  for (const f of files) {
    if (o.signal.aborted || found >= max) break
    if (f.file && candidates && !candidates.has(f.file)) continue
    try {
      // A store's session: one indexed query, then a turn of the event loop (cancel, a stop).
      const h = f.file
        ? await scanFile(f as SearchFile & { file: string }, pattern, re, o)
        : o.own?.(f)
      if (!f.file) await yieldNow()
      if (h) {
        found++
        o.onHit(h)
      }
    } catch {
      // unreadable or gone meanwhile: skipped
    }
  }
  return { capped: found >= max }
}

/** The rg searches running now: the worker kills them when it's stopped. */
export const running = new Set<ReturnType<typeof spawn>>()

/** The files with the words anywhere (`rg -l`), or null if rg couldn't say. */
async function withWords(
  rg: string,
  files: (SearchFile & { file: string })[],
  word: string,
  signal: AbortSignal,
): Promise<Set<string> | null> {
  const found = new Set<string>()
  // A batch at a time: every transcript's path on one command line could pass the OS's limit.
  for (let i = 0; i < files.length; i += RG_BATCH) {
    if (signal.aborted) return null
    const ok = await rgBatch(rg, files.slice(i, i + RG_BATCH), word, signal, found)
    if (!ok) return null
  }
  return found
}

/** One `rg -l` over these files into `found`; false if rg couldn't say. */
function rgBatch(
  rg: string,
  files: (SearchFile & { file: string })[],
  word: string,
  signal: AbortSignal,
  found: Set<string>,
): Promise<boolean> {
  return new Promise((resolve) => {
    const args = ["--files-with-matches", "--ignore-case", "--fixed-strings", "--no-config"]
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(rg, [...args, "-e", onDisk(word), "--", ...files.map((f) => f.file)], {
        stdio: ["ignore", "pipe", "ignore"],
      })
    } catch {
      return resolve(false) // couldn't even start
    }
    const stop = () => child.kill()
    signal.addEventListener("abort", stop, { once: true })
    running.add(child)
    readline.createInterface({ input: child.stdout! }).on("line", (l) => found.add(l))
    const done = (ok: boolean) => {
      running.delete(child)
      signal.removeEventListener("abort", stop)
      resolve(ok)
    }
    // 0: some matched, 1: none did. 2 is an error: one file it couldn't read (what it found in
    // the others counts; the scanner skips that one too), or rg itself failing (an old rg, a bad
    // flag), which finds nothing, so 2 with nothing found is a failure. Killed, no rg: failed.
    const before = found.size
    child.on("close", (code) =>
      done(code === 0 || code === 1 || (code === 2 && found.size > before)),
    )
    child.on("error", () => done(false))
  })
}

const latin1 = (t: string) => Buffer.from(t, "utf8").toString("latin1")
// Whitespace inside a JSON string on disk: a space or tab, or an escaped line break or tab.
const GAP = "(?:[ \\t]|\\\\[nrt])+"

/** The on-disk query as a case-insensitive pattern over latin1 text (one char per byte): its
 *  words JSON-escaped, any whitespace between them. The `i` flag folds ASCII; a letter beyond it
 *  matches either case's UTF-8 bytes. */
export function bytePattern(query: string): RegExp {
  const word = (w: string) => {
    let source = ""
    for (const c of onDisk(w)) {
      const lower = c.toLowerCase()
      const upper = c.toUpperCase()
      source +=
        c.charCodeAt(0) < 0x80 || lower === upper
          ? esc(latin1(c))
          : `(?:${esc(latin1(lower))}|${esc(latin1(upper))})`
    }
    return source
  }
  return new RegExp(words(query).map(word).join(GAP), "gi")
}

// Searched as bytes: decoding gigabytes as UTF-8 and lowercasing them is ~10× slower than latin1
// (one char per byte) and a case-insensitive pattern; only a candidate's line is decoded.
const CHUNK = 4 << 20

/** A file's first hit: big chunks searched as a whole, only a candidate's own line parsed. */
async function scanFile(
  f: SearchFile & { file: string },
  pattern: RegExp,
  query: RegExp,
  o: SearchOptions,
): Promise<SessionHit | undefined> {
  const input = fs.createReadStream(f.file, { highWaterMark: CHUNK })
  let carry = Buffer.alloc(0) // a line cut by the chunk's end
  const scan = (bytes: Buffer): SessionHit | undefined => {
    const text = bytes.toString("latin1")
    pattern.lastIndex = 0
    for (let m = pattern.exec(text); m; m = pattern.exec(text)) {
      const from = text.lastIndexOf("\n", m.index) + 1
      const nl = text.indexOf("\n", m.index)
      const to = nl < 0 ? text.length : nl
      const h = verify(f, bytes.subarray(from, to).toString("utf8"), query, o.texts, o.quick)
      if (h) return h
      pattern.lastIndex = to + 1 // the next line
    }
    return undefined
  }
  try {
    for await (const chunk of input as AsyncIterable<Buffer>) {
      if (o.signal.aborted) return undefined
      const bytes = carry.length ? Buffer.concat([carry, chunk]) : chunk
      const end = bytes.lastIndexOf(0x0a)
      carry = end < 0 ? bytes : bytes.subarray(end + 1)
      if (end < 0) continue
      const h = scan(bytes.subarray(0, end))
      if (h) return h
    }
    return carry.length ? scan(carry) : undefined
  } finally {
    input.destroy()
  }
}
