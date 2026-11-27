import { describe, it, expect, beforeAll, afterAll } from "vitest"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { hashBytes, readFileForTab } from "./read-file"

let dir = ""
beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "minmux-readfile-"))
})
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))
const put = (name: string, data: string | Buffer) => {
  const p = path.join(dir, name)
  fs.writeFileSync(p, data)
  return p
}

describe("readFileForTab", () => {
  it("text, whole", async () => {
    expect(await readFileForTab(put("a.ts", "const x = 1\n"))).toMatchObject({
      kind: "text",
      text: "const x = 1\n",
      truncated: false,
      size: 12,
    })
  })

  it("text carries its bytes' hash and is editable when it's valid UTF-8", async () => {
    const r = await readFileForTab(put("u.ts", "é \uFFFD ok\n"))
    expect(r).toMatchObject({ editable: true, hash: hashBytes(Buffer.from("é \uFFFD ok\n")) })
  })

  it("invalid UTF-8 (Latin-1) isn't editable: saving would write replacement characters", async () => {
    const r = await readFileForTab(put("l.txt", Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a])))
    expect(r).toMatchObject({ kind: "text", editable: false })
  })

  it("text past the cap goes to the editor (too large), not cut off", async () => {
    expect(await readFileForTab(put("big.txt", "x".repeat(100)), 10)).toMatchObject({
      kind: "too-large",
      size: 100,
    })
  })

  it("a file with NUL bytes is binary", async () => {
    expect((await readFileForTab(put("b.bin", Buffer.from([1, 0, 2])))).kind).toBe("binary")
  })

  it("an image is a data URL of its type", async () => {
    const r = await readFileForTab(put("p.png", Buffer.from([137, 80, 78, 71])))
    expect(r).toMatchObject({ kind: "image", size: 4 })
    expect((r as { dataUrl: string }).dataUrl.startsWith("data:image/png;base64,")).toBe(true)
  })

  it("a folder or a missing file says so", async () => {
    expect(await readFileForTab(dir)).toEqual({ kind: "error", message: "Not a file" })
    expect(await readFileForTab(path.join(dir, "nope"))).toEqual({
      kind: "error",
      message: "This file is gone",
      gone: true,
    })
  })

  it("a re-read with the file's own stamp is skipped (it didn't change)", async () => {
    const p = put("s.txt", "same")
    const first = await readFileForTab(p)
    if (first.kind !== "text") throw new Error("expected text")
    expect(await readFileForTab(p, undefined, first.stamp)).toEqual({ kind: "same" })
    fs.writeFileSync(p, "changed!")
    expect((await readFileForTab(p, undefined, first.stamp)).kind).toBe("text")
  })

  it("too large by its size, stamped: a re-read of it is skipped while it doesn't change", async () => {
    const p = put("huge.log", "x".repeat(100))
    const r = await readFileForTab(p, 10)
    expect(r).toMatchObject({ kind: "too-large", size: 100 })
    if (r.kind !== "too-large") throw new Error("expected too-large")
    expect(await readFileForTab(p, 10, r.stamp)).toEqual({ kind: "same" })
  })

  it("a binary is stamped too", async () => {
    const r = await readFileForTab(put("b2.bin", Buffer.from([0, 1])))
    expect(r).toMatchObject({ kind: "binary", stamp: { size: 2 } })
  })
})
