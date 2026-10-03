// One small JSON-ish file the main process rewrites now and then (hint state, named sessions).

import fs from "node:fs"
import path from "node:path"

/** Writes of one file, serialized and atomic (temp + rename): each lands whole, in order. */
export class AtomicFile {
  private writes: Promise<void> = Promise.resolve()

  constructor(readonly file: string) {}

  /** Queue a write; best-effort (a failure keeps the previous content). */
  write(body: string): void {
    const file = this.file
    const tmp = `${file}.${process.pid}.tmp`
    this.writes = this.writes
      .then(async () => {
        await fs.promises.mkdir(path.dirname(file), { recursive: true })
        await fs.promises.writeFile(tmp, body)
        await fs.promises.rename(tmp, file)
      })
      .catch(() => {})
  }

  /** Done when every queued write has landed (tests, quit). */
  flushed(): Promise<void> {
    return this.writes
  }
}
