import { describe, it, expect, beforeEach, afterEach } from "vitest"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { addMetaLine, emptyMeta, TranscriptMeta } from "./transcript-meta"

const color = (c?: string) => JSON.stringify({ type: "agent-color", agentColor: c, sessionId: "s" })
const title = (t: string) =>
  JSON.stringify({ type: "custom-title", customTitle: t, sessionId: "s" })
const turn = JSON.stringify({ type: "assistant", message: { content: "agent-color custom-title" } })

describe("addMetaLine", () => {
  it("reads the latest /color and /rename", () => {
    let m = addMetaLine(emptyMeta, color("orange"))
    m = addMetaLine(m, title("fix-login"))
    m = addMetaLine(m, color("Purple"))
    expect(m).toEqual({ color: "purple", name: "fix-login" })
  })

  it("/color default (or no value) is an explicit reset → null", () => {
    expect(addMetaLine({ color: "red" }, color("default")).color).toBeNull()
    expect(addMetaLine({ color: "red" }, color(undefined)).color).toBeNull()
  })

  it("ignores conversation lines (even mentioning the keywords), junk and blanks", () => {
    const base = { color: "red", name: "n" }
    expect(addMetaLine(base, turn)).toBe(base)
    expect(addMetaLine(base, '{"type":"agent-color",')).toBe(base)
    expect(addMetaLine(base, "")).toBe(base)
  })

  it("returns the same object when nothing changes", () => {
    const m = { color: "blue" }
    expect(addMetaLine(m, color("blue"))).toBe(m)
  })
})

describe("TranscriptMeta (incremental)", () => {
  let dir: string
  let file: string
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "minmux-tm-"))
    file = path.join(dir, "t.jsonl")
  })
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

  it("folds appended lines only, across small chunks", async () => {
    const r = new TranscriptMeta(16) // tiny chunks: lines straddle chunk boundaries
    fs.writeFileSync(file, `${turn}\n${title("first")}\n`)
    expect(await r.update(file)).toEqual({ name: "first" })
    fs.appendFileSync(file, `${color("green")}\n${turn}\n`)
    expect(await r.update(file)).toEqual({ name: "first", color: "green" })
  })

  it("a missing file yields the prior value", async () => {
    expect(await new TranscriptMeta().update(path.join(dir, "nope.jsonl"))).toEqual({})
  })

  it("forget() during an in-flight read doesn't let the read re-insert state", async () => {
    const r = new TranscriptMeta(16)
    fs.writeFileSync(file, `${title("a")}\n`.repeat(50)) // multi-chunk → the read yields
    const pending = r.update(file)
    r.forget(file)
    await pending
    // State was dropped: a fresh read starts from 0 and re-folds (value still correct).
    fs.writeFileSync(file, `${color("red")}\n`)
    expect(await r.update(file)).toEqual({ color: "red" })
  })
})
