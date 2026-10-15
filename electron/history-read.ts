// Reading past agent sessions off disk (docs/design/AGENT_SESSIONS.md): only a transcript's head
// and tail (a Claude transcript can be 200 MB), each file at most once per change, a few at a time.

import fs from "node:fs"
import path from "node:path"

/** The first `headBytes` and last `tailBytes` of a file, cut to whole lines. */
export async function readHeadTail(
  file: string,
  size: number,
  headBytes: number,
  tailBytes = 0,
): Promise<{ head: string; tail: string }> {
  const fh = await fs.promises.open(file, "r")
  try {
    const read = async (at: number, len: number) => {
      const buf = Buffer.alloc(len)
      const { bytesRead } = await fh.read(buf, 0, len, at)
      return buf.subarray(0, bytesRead).toString("utf8")
    }
    const headLen = Math.min(size, headBytes)
    let head = await read(0, headLen)
    // No partial last line, unless there's no whole one (a first line longer than the head: its
    // start is kept for `cwdField`).
    const cut = head.lastIndexOf("\n") + 1
    if (headLen < size && cut > 0) head = head.slice(0, cut)
    // The tail starts where the head's whole lines end, so a line across the cut is in it whole.
    const headEnd = headLen < size && cut === 0 ? 0 : Buffer.byteLength(head)
    let tail = ""
    if (tailBytes > 0 && size > headEnd) {
      const at = Math.max(headEnd, size - tailBytes)
      tail = await read(at, size - at)
      if (at > headEnd) tail = tail.slice(tail.indexOf("\n") + 1) // no partial first line
    }
    return { head, tail }
  } finally {
    await fh.close()
  }
}

/** The first `"cwd":"…"` in text that may be a cut-off JSON line (a huge first line). */
export function cwdField(text: string): string | undefined {
  const m = /"cwd":("(?:[^"\\]|\\.)*")/.exec(text)
  if (!m) return undefined
  try {
    const cwd: unknown = JSON.parse(m[1]!)
    return typeof cwd === "string" && cwd ? cwd : undefined
  } catch {
    return undefined
  }
}

/** One JSONL line as an object (undefined: not JSON, or not an object). */
export function parseLine(line: string): Record<string, unknown> | undefined {
  try {
    const o: unknown = JSON.parse(line)
    return typeof o === "object" && o !== null ? (o as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

/** `p`, or undefined if it takes longer than `ms` (a hung network mount never holds a caller). */
export async function within<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<undefined>((r) => (timer = setTimeout(() => r(undefined), ms)))
  try {
    return await Promise.race([p, late])
  } finally {
    clearTimeout(timer)
  }
}

/** Per-file results, kept while the file's size and mtime stay the same. */
export class FileCache<T> {
  private entries = new Map<string, { size: number; mtimeMs: number; value: T }>()

  get(file: string, size: number, mtimeMs: number): T | undefined {
    const e = this.entries.get(file)
    return e && e.size === size && e.mtimeMs === mtimeMs ? e.value : undefined
  }

  set(file: string, size: number, mtimeMs: number, value: T): void {
    this.entries.set(file, { size, mtimeMs, value })
  }

  /** Drop the files not seen in this listing (deleted transcripts). */
  keepOnly(files: Set<string>): void {
    for (const f of this.entries.keys()) if (!files.has(f)) this.entries.delete(f)
  }
}

/** `fn` over `items`, at most `limit` at once; a failing item gives undefined. */
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<(R | undefined)[]> {
  const out: (R | undefined)[] = new Array(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const i = next++
      try {
        out[i] = await fn(items[i]!)
      } catch {
        out[i] = undefined
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out
}

/** Every `*.jsonl` directly in `dir` (none if it can't be read), with its size and mtime. */
export async function jsonlFiles(
  dir: string,
): Promise<{ file: string; size: number; mtimeMs: number }[]> {
  let names: string[]
  try {
    names = await fs.promises.readdir(dir)
  } catch {
    return []
  }
  const stats = await mapLimit(
    names.filter((n) => n.endsWith(".jsonl")),
    16,
    async (n) => {
      const file = path.join(dir, n)
      const st = await fs.promises.stat(file)
      return st.isFile() ? { file, size: st.size, mtimeMs: st.mtimeMs } : undefined
    },
  )
  return stats.filter((s): s is NonNullable<typeof s> => !!s)
}
