// remote-devices.json on disk: read once without blocking main, written owner-only (it holds the
// PIN's hash), latest-wins, and flushed synchronously at quit without racing an async write.

import fs from "node:fs"
import path from "node:path"

export class DeviceFile {
  private latest: string | null = null // waiting to be written
  private running = false
  private closed = false

  constructor(readonly file: string) {}

  /** The file's contents, or null when there's none (read off main's thread). */
  async read(): Promise<string | null> {
    try {
      return await fs.promises.readFile(this.file, "utf8")
    } catch {
      return null
    }
  }

  /** Queues the newest contents; older queued ones are skipped. */
  write(body: string): void {
    if (this.closed) return
    this.latest = body
    if (!this.running) void this.drain()
  }

  /** Quitting: writes what's still queued now, and stops the async writer. */
  close(): void {
    this.closed = true
    const body = this.latest
    this.latest = null
    if (body === null) return
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      const tmp = `${this.file}.${process.pid}.quit.tmp`
      fs.writeFileSync(tmp, body, { mode: 0o600 })
      fs.renameSync(tmp, this.file)
    } catch {
      // best-effort
    }
  }

  private async drain(): Promise<void> {
    this.running = true
    while (this.latest !== null && !this.closed) {
      const body = this.latest
      this.latest = null
      const tmp = `${this.file}.${process.pid}.tmp`
      try {
        await fs.promises.mkdir(path.dirname(this.file), { recursive: true })
        await fs.promises.writeFile(tmp, body, { mode: 0o600 })
        // close() may have written newer contents meanwhile: never rename an older body over it.
        if (this.closed) break
        await fs.promises.rename(tmp, this.file)
      } catch {
        // best-effort: the next change writes again
      }
    }
    this.running = false
  }

  /** Done when nothing is queued or being written (tests). */
  async idle(): Promise<void> {
    while (this.running) await new Promise((r) => setTimeout(r, 5))
  }
}
