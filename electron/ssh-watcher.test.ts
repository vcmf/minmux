import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { createPathWatcher, type PathWatcher } from "./ssh-watcher"

// Real chokidar on a temp dir: these are about the library's behaviour, not ours.
const until = async (ok: () => boolean, ms = 4000) => {
  const t0 = Date.now()
  while (!ok() && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 50))
  return ok()
}
const settle = () => new Promise((r) => setTimeout(r, 400)) // chokidar's initial scan
/** Write `file` until the watcher reports it: chokidar may still be starting (a busy machine
 *  stretches its scan past `settle`), and one missed write would read as a bug. */
const writeUntilSeen = async (file: string, seen: () => boolean) => {
  for (let i = 0; i < 40 && !seen(); i++) {
    fs.writeFileSync(file, `Host w${i}\n`)
    await new Promise((r) => setTimeout(r, 100))
  }
  return until(seen, 1000)
}

describe("createPathWatcher (real chokidar)", () => {
  let dir: string
  let w: PathWatcher | null = null
  let seen: string[] = []
  beforeEach(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "minmux-watch-")))
    seen = []
  })
  afterEach(() => {
    w?.close()
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  })

  it("reports a change to a watched file", async () => {
    const cfg = path.join(dir, "config")
    fs.writeFileSync(cfg, "Host a\n")
    w = createPathWatcher(
      (p) => seen.push(p),
      () => undefined,
    )
    w.set([cfg])
    await settle()
    expect(await writeUntilSeen(cfg, () => seen.includes(cfg))).toBe(true)
  })

  it("keeps a file inside a dir that stops being watched (chokidar's unwatch trap)", async () => {
    const cfg = path.join(dir, "config")
    fs.writeFileSync(cfg, "Host a\n")
    w = createPathWatcher(
      (p) => seen.push(p),
      () => undefined,
    )
    w.set([cfg, dir]) // e.g. `Include ~/.ssh/*.conf` watched the dir too
    await settle()
    w.set([cfg]) // the Include was removed: the dir leaves the set
    await settle()
    expect(await writeUntilSeen(cfg, () => seen.includes(cfg))).toBe(true)
  })

  it("picks up paths added later, and a file created in a watched dir", async () => {
    const cfg = path.join(dir, "config")
    fs.writeFileSync(cfg, "")
    const sub = path.join(dir, "conf.d")
    fs.mkdirSync(sub)
    w = createPathWatcher(
      (p) => seen.push(p),
      () => undefined,
    )
    w.set([cfg])
    await settle()
    w.set([cfg, sub])
    await settle()
    const extra = path.join(sub, "work.conf")
    expect(await writeUntilSeen(extra, () => seen.includes(extra))).toBe(true)
  })

  it("stops reporting after close", async () => {
    const cfg = path.join(dir, "config")
    fs.writeFileSync(cfg, "")
    w = createPathWatcher(
      (p) => seen.push(p),
      () => undefined,
    )
    w.set([cfg])
    await settle()
    w.close()
    fs.writeFileSync(cfg, "changed")
    expect(await until(() => seen.length > 0, 800)).toBe(false)
  })
})
