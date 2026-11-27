import { describe, it, expect, beforeAll, afterAll } from "vitest"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { hashBytes, readFileForTab } from "./read-file"
import { KeyedQueue, SaveLocks, saveAcross, validSave, writeFileForTab } from "./write-file"
import { FILE_READ_CAP, type SaveResult } from "../src/lib/file-tab"

let dir = ""
beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "minmux-writefile-"))
})
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))
let n = 0
const put = (data: string) => {
  const p = path.join(dir, `f${n++}.txt`)
  fs.writeFileSync(p, data)
  return p
}
const h = (s: string) => hashBytes(Buffer.from(s))

describe("writeFileForTab", () => {
  it("writes over the bytes it was edited from, and answers the new stamp and hash", async () => {
    const p = put("old text\n")
    const r = await writeFileForTab(p, "new\n", h("old text\n"))
    expect(r).toMatchObject({ kind: "saved", hash: h("new\n"), stamp: { size: 4 } })
    expect(fs.readFileSync(p, "utf8")).toBe("new\n") // shorter: cut to length
  })

  it("its answer matches the next read (the tab's re-read is `same`)", async () => {
    const p = put("a\n")
    const r = (await writeFileForTab(p, "b\n", h("a\n"))) as Extract<SaveResult, { kind: "saved" }>
    const read = await readFileForTab(p)
    expect(read).toMatchObject({ hash: r.hash, stamp: { size: r.stamp.size, ino: r.stamp.ino } })
  })

  it("refuses when the file changed since (an agent wrote it)", async () => {
    const p = put("theirs\n")
    expect(await writeFileForTab(p, "mine\n", h("base\n"))).toEqual({ kind: "changed" })
    expect(fs.readFileSync(p, "utf8")).toBe("theirs\n")
  })

  it("a file that grew past its base (an agent appending) is changed, not cut", async () => {
    const p = put("base\nappended\n")
    expect(await writeFileForTab(p, "mine\n", h("base\n"))).toEqual({ kind: "changed" })
    expect(fs.readFileSync(p, "utf8")).toBe("base\nappended\n")
  })

  it("keeps the inode, mode and a symlink", async () => {
    const p = put("a\n")
    fs.chmodSync(p, 0o640)
    const link = path.join(dir, `link${n++}`)
    fs.symlinkSync(p, link)
    const ino = fs.statSync(p).ino
    expect((await writeFileForTab(link, "bb\n", h("a\n"))).kind).toBe("saved")
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true)
    expect(fs.statSync(p).ino).toBe(ino)
    expect(fs.statSync(p).mode & 0o777).toBe(0o640)
    expect(fs.readFileSync(p, "utf8")).toBe("bb\n")
  })

  it("no file there: missing, nothing written", async () => {
    const p = path.join(dir, "gone.txt")
    expect(await writeFileForTab(p, "x", h(""))).toEqual({ kind: "missing" })
    expect(fs.existsSync(p)).toBe(false)
  })

  it("create writes a deleted file back, but never over one that came back", async () => {
    const p = path.join(dir, `new${n++}.txt`)
    expect((await writeFileForTab(p, "x\n", null, true)).kind).toBe("saved")
    expect(fs.readFileSync(p, "utf8")).toBe("x\n")
    expect(await writeFileForTab(p, "y\n", null, true)).toEqual({ kind: "changed" })
  })

  it("create never follows a link whose file is gone", async () => {
    const link = path.join(dir, `dangling${n++}`)
    fs.symlinkSync(path.join(dir, "nowhere.txt"), link)
    expect(await writeFileForTab(link, "x", null, true)).toMatchObject({ kind: "error" })
    expect(fs.existsSync(path.join(dir, "nowhere.txt"))).toBe(false)
  })

  it("text with a lone surrogate isn't written (it would become U+FFFD)", async () => {
    const p = put("a")
    expect(await writeFileForTab(p, "x\uD800y", h("a"))).toMatchObject({ kind: "error" })
    expect(fs.readFileSync(p, "utf8")).toBe("a")
    expect((await writeFileForTab(p, "😀", h("a"))).kind).toBe("saved") // a real pair is fine
  })

  it("two saves of one file through two names run one after the other", async () => {
    const p = put("base\n")
    const link = path.join(dir, `alias${n++}`)
    fs.symlinkSync(p, link)
    const [a, b] = await Promise.all([
      writeFileForTab(p, "first text\n", h("base\n")),
      writeFileForTab(link, "second\n", h("base\n")),
    ])
    expect([a.kind, b.kind].sort()).toEqual(["changed", "saved"]) // the second sees the first
    expect(["first text\n", "second\n"]).toContain(fs.readFileSync(p, "utf8"))
  })

  it("a folder isn't written (it doesn't open for writing)", async () => {
    expect(await writeFileForTab(dir, "x", h(""))).toMatchObject({ kind: "error" })
  })

  it("an empty text empties the file", async () => {
    const p = put("abc")
    expect((await writeFileForTab(p, "", h("abc"))).kind).toBe("saved")
    expect(fs.readFileSync(p, "utf8")).toBe("")
  })

  it("text past the cap isn't written", async () => {
    const p = put("a")
    const r = await writeFileForTab(p, "x".repeat(FILE_READ_CAP + 1), h("a"))
    expect(r.kind).toBe("error")
    expect(fs.readFileSync(p, "utf8")).toBe("a")
  })

  it("UTF-8 out, BOM and CRLF as given", async () => {
    const p = put("x")
    await writeFileForTab(p, "\uFEFFé\r\n", h("x"))
    expect(fs.readFileSync(p)).toEqual(Buffer.from([0xef, 0xbb, 0xbf, 0xc3, 0xa9, 0x0d, 0x0a]))
  })
})

describe("saveAcross", () => {
  it("tries the next share form only where there's no file", async () => {
    const seen: string[] = []
    const r = await saveAcross(["a", "b"], async (t) => {
      seen.push(t)
      return t === "a" ? { kind: "missing" } : { kind: "changed" }
    })
    expect(seen).toEqual(["a", "b"])
    expect(r).toEqual({ kind: "changed" })
  })

  it("moves on when a share form wouldn't open, as a read does", async () => {
    const seen: string[] = []
    const r = await saveAcross(["a", "b"], async (t) => {
      seen.push(t)
      return t === "a" ? { kind: "error", message: "EPERM", unopened: true } : { kind: "changed" }
    })
    expect(seen).toEqual(["a", "b"])
    expect(r).toEqual({ kind: "changed" })
  })

  it("a form that has the file but won't open it wins over a later missing", async () => {
    const r = await saveAcross(["a", "b"], async (t) =>
      t === "a" ? { kind: "error", message: "EACCES", unopened: true } : { kind: "missing" },
    )
    expect(r).toMatchObject({ kind: "error", message: "EACCES" })
  })

  it("stops at the first answer", async () => {
    const seen: string[] = []
    await saveAcross(["a", "b"], async (t) => {
      seen.push(t)
      return { kind: "error", message: "EACCES" }
    })
    expect(seen).toEqual(["a"])
  })

  it("a hang or a lost worker is unknown, and nothing more is tried", async () => {
    for (const code of ["EHUNG", "EWORKER", "EUNSURE"]) {
      const seen: string[] = []
      const r = await saveAcross(["a", "b"], async (t) => {
        seen.push(t)
        throw Object.assign(new Error(code), { code })
      })
      expect(r).toEqual({ kind: "unknown" })
      expect(seen).toEqual(["a"])
    }
  })

  it("a write that never started is an error", async () => {
    const r = await saveAcross(["a"], async () => {
      throw Object.assign(new Error("EBUSY"), { code: "EBUSY" })
    })
    expect(r.kind).toBe("error")
  })
})

describe("validSave", () => {
  const abs = path.isAbsolute
  it("an absolute path, text and a base", () => {
    expect(validSave("/a/b.ts", "x", "hash", undefined, abs)).toBe(true)
    expect(validSave("/a/b.ts", "x", null, true, abs)).toBe(true)
  })
  it("refuses odd input", () => {
    expect(validSave("rel/b.ts", "x", "h", undefined, abs)).toBe(false)
    expect(validSave("", "x", "h", undefined, abs)).toBe(false)
    expect(validSave("/a\0b", "x", "h", undefined, abs)).toBe(false)
    expect(validSave("/a", 1, "h", undefined, abs)).toBe(false)
    expect(validSave("/a", "x", 5, undefined, abs)).toBe(false)
    expect(validSave("/a", "x", null, undefined, abs)).toBe(false) // no base, not a create
    expect(validSave("/a", "x", "h", "yes", abs)).toBe(false)
    expect(validSave("/a", "x".repeat(FILE_READ_CAP + 1), "h", undefined, abs)).toBe(false)
  })
})

describe("KeyedQueue", () => {
  it("runs one task per key at a time, in order; other keys don't wait", async () => {
    const q = new KeyedQueue()
    const log: string[] = []
    let release!: () => void
    const first = q.run("a", () =>
      new Promise<void>((r) => (release = r)).then(() => log.push("a1")),
    )
    const second = q.run("a", async () => void log.push("a2"))
    await q.run("b", async () => void log.push("b"))
    expect(log).toEqual(["b"])
    release()
    await Promise.all([first, second])
    expect(log).toEqual(["b", "a1", "a2"])
  })

  it("a failed task frees its key", async () => {
    const q = new KeyedQueue()
    await expect(q.run("a", async () => Promise.reject(new Error("x")))).rejects.toThrow("x")
    await expect(q.run("a", async () => 1)).resolves.toBe(1)
  })
})

describe("SaveLocks", () => {
  const saved: SaveResult = { kind: "saved", stamp: { size: 1, mtimeMs: 1 }, hash: "h" }

  it("saves of one file run in order", async () => {
    const locks = new SaveLocks()
    const log: string[] = []
    let release!: () => void
    const a = locks.run("/f", async () => {
      await new Promise<void>((r) => (release = r))
      log.push("a")
      return saved
    })
    const b = locks.run("/f", async () => (log.push("b"), saved))
    await Promise.resolve()
    expect(log).toEqual([])
    release()
    await Promise.all([a, b])
    expect(log).toEqual(["a", "b"])
  })

  it("after a save that may still land, the file's saves fail at once until its process is gone", async () => {
    const locks = new SaveLocks()
    let gone!: () => void
    const ended = new Promise<void>((r) => (gone = r))
    const first = locks.run("/f", async (track) => {
      track(ended)
      return { kind: "unknown" }
    })
    const queued = locks.run("/f", async () => saved) // waiting behind it
    expect(await first).toEqual({ kind: "unknown" })
    expect(await queued).toMatchObject({ kind: "error" })
    expect(await locks.run("/f", async () => saved)).toMatchObject({ kind: "error" })
    expect(await locks.run("/other", async () => saved)).toEqual(saved) // other files don't wait
    gone()
    await ended
    await new Promise((r) => setTimeout(r, 0))
    expect(await locks.run("/f", async () => saved)).toEqual(saved)
  })
})
