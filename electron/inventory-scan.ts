// The Fleet inventory's history scan (docs/design/FLEET_GRAPH.md, step 6), in the sessions
// worker: every agent's transcripts folded into uses per day. Each file is read from where the
// last scan stopped, and those places and counts live in a cache file (`inventory-cache.json`
// in minmux's config folder), so a relaunch reads only what's new. One rollout can be 16 GB:
// reads are chunked and never held whole.
import fs from "node:fs"
import path from "node:path"
import type { AgentKind } from "../src/lib/agent-graph"
import type { Inventory, InventoryAgent, Uses } from "../src/lib/fleet-inventory"

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
  /** Uses kept elsewhere than in files (OpenCode's database), read from `after` on. */
  store?(after: number): Promise<{ until: number; days: Record<string, Uses> }>
}

interface FileEntry {
  size: number
  mtime: number
  offset: number
  acc: DayAcc
}

export interface InventoryCache {
  v: 1
  files: Record<string, FileEntry>
  stores: Partial<Record<AgentKind, { until: number; days: Record<string, Uses> }>>
}

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
    const buf = Buffer.alloc(CHUNK)
    while (pos < size) {
      const { bytesRead } = await h.read(buf, 0, Math.min(CHUNK, size - pos), pos)
      if (!bytesRead) break
      pos += bytesRead
      let chunk = carry.length
        ? Buffer.concat([carry, buf.subarray(0, bytesRead)])
        : buf.subarray(0, bytesRead)
      let start = 0
      for (let nl = chunk.indexOf(0x0a, start); nl >= 0; nl = chunk.indexOf(0x0a, start)) {
        onLine(chunk.toString("utf8", start, nl))
        start = nl + 1
      }
      done = pos - (chunk.length - start)
      carry = Buffer.from(chunk.subarray(start))
      if (carry.length > MAX_LINE) {
        carry = Buffer.alloc(0) // (past a giant line: what follows its end is read on)
        done = pos
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

const emptyCache = (): InventoryCache => ({ v: 1, files: {}, stores: {} })

export async function readCache(file: string): Promise<InventoryCache> {
  try {
    const c = JSON.parse(await fs.promises.readFile(file, "utf8")) as InventoryCache
    return c?.v === 1 && c.files && typeof c.files === "object"
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

/** Scan every source's files (only what's new since the cache), and add it all up. */
export async function scanInventory(
  sources: InventorySource[],
  cacheFile: string,
  signal?: AbortSignal,
): Promise<Inventory> {
  const cache = await readCache(cacheFile)
  const seen = new Set<string>()
  const out: Inventory = {}
  for (const src of sources) {
    const agent: InventoryAgent = { days: {}, mcpLoaded: [], skillsLoaded: [] }
    const mcpLoaded = new Set<string>()
    const skillsLoaded = new Set<string>()
    let files: Awaited<ReturnType<InventorySource["files"]>> = []
    try {
      files = await src.files()
    } catch {
      // can't list them: none
    }
    for (const f of files) {
      if (signal?.aborted) break
      seen.add(f.file)
      let e = cache.files[f.file]
      // A file that shrank or was replaced is read again from the start.
      if (!e || f.size < e.offset) e = { size: 0, mtime: 0, offset: 0, acc: emptyAcc() }
      if (f.size > e.offset) {
        const day = new Date(f.mtimeMs).toISOString().slice(0, 10)
        let acc = e.acc
        try {
          const offset = await readLines(f.file, e.offset, f.size, (l) => {
            acc = src.line(acc, l, day)
          })
          e = { size: f.size, mtime: f.mtimeMs, offset, acc }
        } catch {
          continue // (gone or unreadable meanwhile: next scan)
        }
      }
      cache.files[f.file] = e
      for (const [d, u] of Object.entries(e.acc.days))
        addInto((agent.days[d] ??= { mcp: {}, skills: {} }), u)
      for (const s of e.acc.mcpLoaded) mcpLoaded.add(s)
      for (const s of e.acc.skillsLoaded) skillsLoaded.add(s)
    }
    if (src.store) {
      const had = cache.stores[src.kind] ?? { until: 0, days: {} }
      try {
        const more = await src.store(had.until)
        const days = { ...had.days }
        for (const [d, u] of Object.entries(more.days))
          addInto((days[d] = days[d] ? structuredClone(days[d]) : { mcp: {}, skills: {} }), u)
        cache.stores[src.kind] = { until: more.until, days }
      } catch {
        // its store can't be read now: what the cache had
      }
      for (const [d, u] of Object.entries(cache.stores[src.kind]?.days ?? {}))
        addInto((agent.days[d] ??= { mcp: {}, skills: {} }), u)
    }
    const now = await src.loaded().catch(() => ({ mcp: [], skills: [] as string[] | null }))
    for (const s of now.mcp) mcpLoaded.add(s)
    agent.mcpLoaded = [...mcpLoaded]
    if (now.skills === null) agent.skillsLoaded = null
    else {
      for (const s of now.skills) skillsLoaded.add(s)
      agent.skillsLoaded = [...skillsLoaded]
    }
    out[src.kind] = agent
  }
  // Files gone from disk leave the cache (their counts went with them).
  if (!signal?.aborted)
    for (const f of Object.keys(cache.files)) if (!seen.has(f)) delete cache.files[f]
  await writeCache(cacheFile, cache).catch(() => {})
  return out
}
