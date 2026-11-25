// The Fleet inventory's history scan (docs/design/FLEET_GRAPH.md, step 6), in the sessions
// worker: every agent's transcripts folded into uses per day. Each file is read from where the
// last scan stopped, and those places and counts live in a cache file (`inventory-cache.json`
// in minmux's config folder), so a relaunch reads only what's new. One rollout can be 16 GB:
// reads are chunked and never held whole.
import fs from "node:fs"
import path from "node:path"
import type { AgentKind } from "../src/lib/agent-graph"
import type { Inventory, InventoryAgent, Uses } from "../src/lib/fleet-inventory"
import { wireName } from "./agents/toolbox"

/** What a file's lines added up to so far. */
export interface DayAcc {
  days: Record<string, Uses>
  mcpLoaded: string[]
  skillsLoaded: string[]
}

export const emptyAcc = (): DayAcc => ({ days: {}, mcpLoaded: [], skillsLoaded: [] })

/** One agent's transcripts and how to fold a line of them (`day`: the file's, for a line
 *  without its own timestamp). */
export interface InventorySource {
  kind: AgentKind
  files(): Promise<{ file: string; size: number; mtimeMs: number }[]>
  line(acc: DayAcc, line: string, day: string): DayAcc
  /** What its config says it has now (servers; skills, null: not supported). */
  loaded(): Promise<{ mcp: string[]; skills: string[] | null }>
  /** Uses kept elsewhere than in files (OpenCode's database), read on from `after`; kept raw
   *  in the cache and made into uses by `resolve` when the result is built. */
  store?(after: StoreMark): Promise<{ until: StoreMark; days: Record<string, Uses> }>
  resolve?(days: Record<string, Uses>): Promise<Record<string, Uses>>
}

/** Where a store was read up to: a row's time, and its id among rows of that time. */
export interface StoreMark {
  t: number
  id: string
}

interface FileEntry {
  kind?: AgentKind // whose (a file not listed one time still counts for it)
  size: number
  mtime: number
  offset: number
  acc: DayAcc
}

export interface InventoryCache {
  v: 1
  files: Record<string, FileEntry>
  stores: Partial<Record<AgentKind, { until: StoreMark; days: Record<string, Uses> }>>
}

/** The cache's format; a file of a later one (a newer build's) is never written over. */
const CACHE_V = 1

const CHUNK = 1 << 18
const MAX_LINE = 8 * 1024 * 1024 // (a line longer than this is no record we count: skipped)

/** Feed the complete lines of `file` from `offset` to `size` to `onLine`; returns where the
 *  last complete line ended (a partial tail is read again next time). */
export async function readLines(
  file: string,
  offset: number,
  size: number,
  onLine: (line: string) => void,
): Promise<number> {
  const h = await fs.promises.open(file, "r")
  try {
    let pos = offset
    let done = offset
    let carry: Buffer = Buffer.alloc(0)
    let skipping = false // (inside a giant line: up to its end is no line)
    const buf = Buffer.alloc(CHUNK)
    while (pos < size) {
      const { bytesRead } = await h.read(buf, 0, Math.min(CHUNK, size - pos), pos)
      if (!bytesRead) break
      pos += bytesRead
      let chunk = carry.length
        ? Buffer.concat([carry, buf.subarray(0, bytesRead)])
        : buf.subarray(0, bytesRead)
      let start = 0
      if (skipping) {
        const nl = chunk.indexOf(0x0a)
        if (nl < 0) {
          // (the saved place stays at the giant line's start: a scan stopped here skips it
          // again next time)
          carry = Buffer.alloc(0)
          await new Promise((r) => setImmediate(r))
          continue
        }
        start = nl + 1
        skipping = false
      }
      for (let nl = chunk.indexOf(0x0a, start); nl >= 0; nl = chunk.indexOf(0x0a, start)) {
        onLine(chunk.toString("utf8", start, nl))
        start = nl + 1
      }
      done = pos - (chunk.length - start)
      carry = Buffer.from(chunk.subarray(start))
      if (carry.length > MAX_LINE) {
        carry = Buffer.alloc(0) // (a giant line: skipped to its end)
        skipping = true
      }
      chunk = Buffer.alloc(0)
      // (yield: a scan of gigabytes never holds the worker for long)
      await new Promise((r) => setImmediate(r))
    }
    return done
  } finally {
    await h.close()
  }
}

/** Add `u`'s counts into `into` (mutating: the scan's own accumulators). */
export function addInto(into: Uses, u: Uses) {
  const add = (a: Record<string, number>, b: Record<string, number> | undefined) => {
    for (const [k, n] of Object.entries(b ?? {})) a[k] = (a[k] ?? 0) + n
  }
  add(into.mcp, u.mcp)
  if (u.mcpFailed) add((into.mcpFailed ??= {}), u.mcpFailed)
  add(into.skills, u.skills)
}

const emptyCache = (): InventoryCache => ({ v: CACHE_V, files: {}, stores: {} })

/** The cache, or an empty one; `newer`: written by a later build (kept, never written over). */
export async function readCache(file: string): Promise<InventoryCache & { newer?: true }> {
  try {
    const c = JSON.parse(await fs.promises.readFile(file, "utf8")) as InventoryCache
    if (typeof c?.v === "number" && c.v > CACHE_V) return { ...emptyCache(), newer: true }
    return c?.v === CACHE_V && c.files && typeof c.files === "object"
      ? { ...c, stores: c.stores ?? {} }
      : emptyCache()
  } catch {
    return emptyCache()
  }
}

/** Write the cache whole, through a temporary file (a crash mid-write leaves the old one). */
export async function writeCache(file: string, cache: InventoryCache) {
  await fs.promises.mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  await fs.promises.writeFile(tmp, JSON.stringify(cache))
  await fs.promises.rename(tmp, file)
}

const SAVE_MS = 20_000 // (a long first scan keeps what it read even if it's stopped)

/** Scan every source's files (only what's new since the cache), and add it all up. Files are
 *  taken to be append-only: one that shrank is read again from the start. */
export async function scanInventory(
  sources: InventorySource[],
  cacheFile: string,
  signal?: AbortSignal,
): Promise<Inventory> {
  const cache = await readCache(cacheFile)
  const { newer } = cache
  delete cache.newer
  let saved = Date.now()
  const save = async () => {
    saved = Date.now()
    if (!newer) await writeCache(cacheFile, cache).catch(() => {})
  }
  const seen = new Set<string>()
  const out: Inventory = {}
  const day = (ms: number) => new Date(ms).toISOString().slice(0, 10)
  for (const src of sources) {
    const agent: InventoryAgent = { days: {}, loaded: {}, mcpNow: [], skillsNow: [] }
    const take = (e: FileEntry) => {
      for (const [d, u] of Object.entries(e.acc.days))
        addInto((agent.days[d] ??= { mcp: {}, skills: {} }), u)
      // (what a session had loaded counts on its file's last day)
      if (e.acc.mcpLoaded.length || e.acc.skillsLoaded.length) {
        const l = (agent.loaded[day(e.mtime)] ??= { mcp: [], skills: [] })
        for (const s of e.acc.mcpLoaded) if (!l.mcp.includes(s)) l.mcp.push(s)
        for (const s of e.acc.skillsLoaded) if (!l.skills.includes(s)) l.skills.push(s)
      }
    }
    let files: Awaited<ReturnType<InventorySource["files"]>> = []
    try {
      files = await src.files()
    } catch {
      // can't list them: what the cache has stays and counts (below)
    }
    const listed = new Set<string>()
    for (const f of files) {
      if (signal?.aborted) break
      seen.add(f.file)
      listed.add(f.file)
      const had = cache.files[f.file]
      let e: FileEntry =
        had && f.size >= had.offset
          ? had
          : { kind: src.kind, size: 0, mtime: 0, offset: 0, acc: emptyAcc() }
      if (f.size > e.offset) {
        // (the cached tally is copied first: a read that fails keeps it as it was)
        let acc: DayAcc = structuredClone(e.acc)
        try {
          const offset = await readLines(f.file, e.offset, f.size, (l) => {
            acc = src.line(acc, l, day(f.mtimeMs))
          })
          e = { kind: src.kind, size: f.size, mtime: f.mtimeMs, offset, acc }
        } catch {
          // unreadable for now: what was read before counts, the rest next scan
        }
      }
      if (e.offset) cache.files[f.file] = { ...e, kind: src.kind }
      take(e)
      if (Date.now() - saved > SAVE_MS) await save()
    }
    // Its files the listing missed this time (a folder unreadable for a moment) still count.
    for (const [file, e] of Object.entries(cache.files))
      if (e.kind === src.kind && !listed.has(file)) take(e)
    if (src.store) {
      const kept = cache.stores[src.kind]
      // (a mark of another shape is no place to read on from: read it all again)
      const had =
        kept && typeof kept.until === "object" && typeof kept.until?.t === "number"
          ? kept
          : { until: { t: 0, id: "" }, days: {} }
      try {
        const more = await src.store(had.until)
        const days = structuredClone(had.days)
        for (const [d, u] of Object.entries(more.days))
          addInto((days[d] ??= { mcp: {}, skills: {} }), u)
        cache.stores[src.kind] = { until: more.until, days }
      } catch {
        // its store can't be read now: what the cache had
      }
      const raw = cache.stores[src.kind]?.days ?? {}
      const days = src.resolve
        ? await src.resolve(raw).catch((): Record<string, Uses> => ({}))
        : raw
      for (const [d, u] of Object.entries(days))
        addInto((agent.days[d] ??= { mcp: {}, skills: {} }), u)
    }
    const now = await src.loaded().catch(() => ({ mcp: [], skills: [] as string[] | null }))
    // A server seen in tool names under its wire name (`my_server`) is shown by its configured
    // one (`my.server`), as the live lists do.
    const alias = new Map(now.mcp.map((c) => [wireName(c), c]))
    const named = (m: Record<string, number>) => {
      const o: Record<string, number> = {}
      for (const [k, n] of Object.entries(m)) {
        const name = alias.get(k) ?? k
        o[name] = (o[name] ?? 0) + n
      }
      return o
    }
    for (const u of Object.values(agent.days)) {
      u.mcp = named(u.mcp)
      if (u.mcpFailed) u.mcpFailed = named(u.mcpFailed)
    }
    for (const l of Object.values(agent.loaded))
      l.mcp = [...new Set(l.mcp.map((s) => alias.get(s) ?? s))]
    agent.mcpNow = now.mcp
    agent.skillsNow = now.skills
    out[src.kind] = agent
  }
  // A file no longer on disk leaves the cache (its counts went with it); one that just wasn't
  // listed this time (a folder unreadable for a moment) stays.
  if (!signal?.aborted)
    for (const f of Object.keys(cache.files))
      if (!seen.has(f)) {
        const gone = await fs.promises.access(f).then(
          () => false,
          (e: NodeJS.ErrnoException) => e.code === "ENOENT",
        )
        if (gone) delete cache.files[f]
      }
  await save()
  return out
}
