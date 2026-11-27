// The chat view's conversation, kept per watched pane in the remote-host worker: items upserted by
// id (a tool's result lands on its earlier call), the newest MAX_ITEMS kept. JsonlChat reads an
// append-only transcript incrementally (Claude, Codex) in bounded slices that yield.

import fs from "node:fs"
import { StringDecoder } from "node:string_decoder"
import type { ChatItem } from "../../src/lib/remote-chat"

export const MAX_ITEMS = 2000
const CHUNK = 1 << 18

/** A conversation being built: ordered items, upserted by id; reports what changed. */
export class ChatLog {
  items: ChatItem[] = []
  private at = new Map<string, number>() // id → index in items
  private changed = new Map<string, ChatItem>()
  /** A tool call's id (tool_use_id, call_id) → the item its result belongs to. */
  calls = new Map<string, string>()

  upsert(item: ChatItem): void {
    const i = this.at.get(item.id)
    if (i === undefined) {
      this.at.set(item.id, this.items.length)
      this.items.push(item)
    } else this.items[i] = item
    this.changed.set(item.id, item)
  }

  get(id: string): ChatItem | undefined {
    const i = this.at.get(id)
    return i === undefined ? undefined : this.items[i]
  }

  /** What changed since the last call (new or updated), in conversation order. */
  takeChanged(): ChatItem[] {
    this.trim()
    const out = [...this.changed.values()].filter((it) => this.at.has(it.id))
    this.changed.clear()
    return out.sort((a, b) => this.at.get(a.id)! - this.at.get(b.id)!)
  }

  private trim(): void {
    const over = this.items.length - MAX_ITEMS
    if (over <= 0) return
    this.items = this.items.slice(over)
    this.at = new Map(this.items.map((it, i) => [it.id, i]))
    for (const [k, v] of this.calls) if (!this.at.has(v)) this.calls.delete(k)
  }
}

/** A chat reader: reads what's new, reports changed items. */
export interface ChatReader {
  read(): Promise<ChatItem[]>
  readonly log: ChatLog
  close(): void
}

/** Folds one parsed transcript line into the log (agent-specific). */
export type LineHandler = (o: Record<string, unknown>, log: ChatLog, lineNo: number) => void

const pause = () => new Promise<void>((r) => setImmediate(r))

/** An append-only JSONL transcript, read from where it left off. */
export class JsonlChat implements ChatReader {
  readonly log = new ChatLog()
  private offset = 0
  private rest = ""
  private decoder = new StringDecoder("utf8") // a character split across two reads stays whole
  private lineNo = 0
  private file: string | null = null
  private reading: Promise<ChatItem[]> | null = null

  constructor(
    private readonly files: string[], // candidates (a WSL path's host forms): the first that exists
    private readonly handle: LineHandler,
  ) {}

  read(): Promise<ChatItem[]> {
    // One read at a time: two would fold the same bytes twice.
    this.reading ??= this.readNew().finally(() => (this.reading = null))
    return this.reading
  }

  close(): void {}

  private async readNew(): Promise<ChatItem[]> {
    this.file ??= await firstExisting(this.files)
    if (!this.file) return []
    let fh: fs.promises.FileHandle
    try {
      fh = await fs.promises.open(this.file, "r")
    } catch {
      return []
    }
    try {
      const { size } = await fh.stat()
      if (size < this.offset) {
        // Rewritten from the start (rare): read it again.
        this.offset = 0
        this.rest = ""
        this.lineNo = 0
        this.decoder = new StringDecoder("utf8")
      }
      const buf = Buffer.alloc(CHUNK)
      while (this.offset < size) {
        const { bytesRead } = await fh.read(
          buf,
          0,
          Math.min(CHUNK, size - this.offset),
          this.offset,
        )
        if (bytesRead === 0) break
        this.offset += bytesRead
        const text = this.rest + this.decoder.write(buf.subarray(0, bytesRead))
        const lines = text.split("\n")
        this.rest = lines.pop() ?? ""
        for (const line of lines) this.fold(line)
        await pause()
      }
    } finally {
      await fh.close()
    }
    return this.log.takeChanged()
  }

  private fold(line: string): void {
    this.lineNo++
    if (!line.trim()) return
    try {
      const o = JSON.parse(line) as unknown
      if (o && typeof o === "object")
        this.handle(o as Record<string, unknown>, this.log, this.lineNo)
    } catch {
      // a torn or foreign line: skipped (transcripts are internal formats)
    }
  }
}

async function firstExisting(files: string[]): Promise<string | null> {
  for (const f of files) {
    try {
      if ((await fs.promises.stat(f)).isFile()) return f
    } catch {
      // next
    }
  }
  return null
}
