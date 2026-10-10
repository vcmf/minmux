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
const writeUntilSeen = async (file: string, seen: () => boolean, ms = 3000) => {
  const deadline = Date.now() + ms // by the clock: with the tests' settles, under the 5 s timeout
  for (let i = 0; !seen() && Date.now() < deadline; i++) {
    fs.writeFileSync(file, `Host w${i}\n`)
    await new Promise((r) => setTimeout(r, 100))
  }
  return seen()
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
    // A NEW file each try (never a rewrite): only a reported create can pass.
    let made: string[] = []
    const createdSeen = () => made.some((f) => seen.includes(f))
    const deadline = Date.now() + 3000
    for (let i = 0; !createdSeen() && Date.now() < deadline; i++) {
      const extra = path.join(sub, `work-${i}.conf`)
      made = [...made, extra]
      fs.writeFileSync(extra, "Host w\n")
      await new Promise((r) => setTimeout(r, 100))
    }
    expect(createdSeen()).toBe(true)
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
    // Prove it's live first — else a watcher that never started would "stop" vacuously.
    expect(await writeUntilSeen(cfg, () => seen.includes(cfg), 2500)).toBe(true)
    w.close()
    seen = []
    fs.writeFileSync(cfg, "changed")
    expect(await until(() => seen.length > 0, 800)).toBe(false)
  })
})
