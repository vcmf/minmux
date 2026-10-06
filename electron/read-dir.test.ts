import { describe, it, expect, beforeAll, afterAll, vi, afterEach } from "vitest"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { readDirListing } from "./read-dir"

const posix = process.platform !== "win32" // symlinks need privileges on Windows

let tmp = ""
beforeAll(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "minmux-readdir-")))
})
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }))
afterEach(() => vi.restoreAllMocks())

const mk = (name: string) => {
  const d = path.join(tmp, name)
  fs.mkdirSync(d, { recursive: true })
  return d
}

describe.skipIf(!posix)("readDirListing", () => {
  it("dirs first; a symlinked folder browses as a folder, a dangling link is a file; .git dropped", async () => {
    const d = mk("basic")
    fs.mkdirSync(path.join(d, "real"))
    fs.mkdirSync(path.join(d, ".git"))
    fs.writeFileSync(path.join(d, "b.txt"), "")
    fs.symlinkSync(path.join(d, "real"), path.join(d, "a-link"))
    fs.symlinkSync(path.join(d, "missing"), path.join(d, "dangling"))
    expect(await readDirListing(d)).toEqual({
      entries: [
        { name: "a-link", isDir: true },
        { name: "real", isDir: true },
        { name: "b.txt", isDir: false },
        { name: "dangling", isDir: false },
      ],
      truncated: false,
      total: 4,
    })
  })

  it("over the cap: only the kept entries' links are stat-ed, and the total is the real count", async () => {
    const d = mk("big")
    const target = mk("big-target")
    for (let i = 0; i < 300; i++)
      fs.symlinkSync(target, path.join(d, `l${String(i).padStart(3, "0")}`))
    const stat = vi.spyOn(fs.promises, "stat")
    const l = await readDirListing(d, { cap: 20 })
    expect(stat).toHaveBeenCalledTimes(20)
    expect(l.entries).toHaveLength(20)
    expect(l.entries.every((e) => e.isDir)).toBe(true)
    expect(l).toMatchObject({ truncated: true, total: 300 })
  })

  it("stats links a batch at a time (never more in flight than the batch)", async () => {
    const d = mk("batched")
    const target = mk("batched-target")
    for (let i = 0; i < 100; i++) fs.symlinkSync(target, path.join(d, `l${i}`))
    const real = fs.promises.stat
    let inFlight = 0
    let peak = 0
    vi.spyOn(fs.promises, "stat").mockImplementation(async (...a: Parameters<typeof real>) => {
      peak = Math.max(peak, ++inFlight)
      try {
        return await real(...a)
      } finally {
        inFlight--
      }
    })
    const l = await readDirListing(d, { batch: 8 })
    expect(peak).toBe(8)
    expect(l.entries).toHaveLength(100)
  })

  it("a missing folder rejects (the handler then tries the next candidate)", async () => {
    await expect(readDirListing(path.join(tmp, "nope"))).rejects.toThrow()
  })
})
