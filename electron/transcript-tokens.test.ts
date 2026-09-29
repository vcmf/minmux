import { describe, it, expect, beforeEach, afterEach } from "vitest"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { addLine, emptyUsage, TranscriptTokens } from "./transcript-tokens"

const asst = (u: Record<string, number>) =>
  JSON.stringify({ type: "assistant", message: { role: "assistant", usage: u } })

describe("addLine", () => {
  it("context = input + cacheRead + cacheCreate; output accumulates", () => {
    const u = addLine(emptyUsage, asst({ input_tokens: 10, output_tokens: 5 }))
    expect(u).toEqual({ context: 10, output: 5 })
    const u2 = addLine(
      u,
      asst({
        input_tokens: 1,
        output_tokens: 2,
        cache_read_input_tokens: 4,
        cache_creation_input_tokens: 3,
      }),
    )
    expect(u2).toEqual({ context: 8, output: 7 }) // context overwritten (1+4+3), output 5+2
  })

  it("ignores non-assistant, malformed, and empty lines (context stays at the last turn)", () => {
    const base = { context: 42, output: 9 }
    expect(addLine(base, JSON.stringify({ type: "user", message: {} }))).toEqual(base)
    expect(addLine(base, "{not json")).toEqual(base)
    expect(addLine(base, "")).toEqual(base)
    expect(addLine(base, JSON.stringify({ type: "assistant", message: null }))).toEqual(base)
  })
})

describe("TranscriptTokens", () => {
  let dir: string
  let file: string
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "minmux-tt-"))
    file = path.join(dir, "t.jsonl")
  })
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

  it("reads a transcript: context = last turn's input, output = total", async () => {
    fs.writeFileSync(file, `${asst({ input_tokens: 10, output_tokens: 4 })}\n`)
    const t = new TranscriptTokens()
    expect(await t.update(file)).toEqual({ context: 10, output: 4 })
  })

  it("reads incrementally — output accumulates, context tracks the latest turn", async () => {
    const t = new TranscriptTokens()
    fs.writeFileSync(file, `${asst({ input_tokens: 10, output_tokens: 1 })}\n`)
    expect(await t.update(file)).toEqual({ context: 10, output: 1 })
    fs.appendFileSync(file, `${asst({ input_tokens: 20, output_tokens: 2 })}\n`)
    expect(await t.update(file)).toEqual({ context: 20, output: 3 }) // context=latest, output=1+2
  })

  it("leaves a partial (not-yet-newline-terminated) trailing line for next time", async () => {
    const t = new TranscriptTokens()
    fs.writeFileSync(
      file,
      `${asst({ input_tokens: 5, output_tokens: 1 })}\n${asst({ input_tokens: 99, output_tokens: 9 })}`,
    )
    expect(await t.update(file)).toEqual({ context: 5, output: 1 }) // 2nd line unterminated → skipped
    fs.appendFileSync(file, "\n") // now it's complete
    expect(await t.update(file)).toEqual({ context: 99, output: 10 }) // context=99 (latest), output=1+9
  })

  it("is correct with a tiny chunk size that splits lines across reads", async () => {
    // chunkBytes=8 forces many slices mid-line; carry-across-chunks must still fold exactly.
    const lines = [
      asst({ input_tokens: 100, output_tokens: 10 }),
      asst({ input_tokens: 200, output_tokens: 20 }),
      asst({ input_tokens: 300, output_tokens: 30 }),
    ]
    fs.writeFileSync(file, lines.map((l) => `${l}\n`).join(""))
    const t = new TranscriptTokens(8)
    expect(await t.update(file)).toEqual({ context: 300, output: 60 }) // context=last, output=sum
  })

  it("keeps the byte offset exact across multibyte content with a tiny chunk size", async () => {
    const t = new TranscriptTokens(4)
    // A multibyte line first (must not corrupt the offset), then a usage line.
    fs.writeFileSync(file, `${JSON.stringify({ type: "user", message: { t: "café €🚀" } })}\n`)
    expect(await t.update(file)).toEqual(emptyUsage)
    fs.appendFileSync(file, `${asst({ input_tokens: 7, output_tokens: 3 })}\n`)
    expect(await t.update(file)).toEqual({ context: 7, output: 3 })
  })

  it("returns empty for a missing file (best-effort, no throw)", async () => {
    expect(await new TranscriptTokens().update(path.join(dir, "nope.jsonl"))).toEqual(emptyUsage)
  })

  it("re-reads from the start if the file shrank (rotation/truncation)", async () => {
    const t = new TranscriptTokens()
    fs.writeFileSync(file, `${asst({ input_tokens: 50, output_tokens: 5 })}\n`)
    expect(await t.update(file)).toEqual({ context: 50, output: 5 })
    fs.writeFileSync(file, `${asst({ input_tokens: 8, output_tokens: 1 })}\n`) // smaller → reset
    expect(await t.update(file)).toEqual({ context: 8, output: 1 })
  })

  it("reads the first reachable candidate (WSL UNC-share fallback shape)", async () => {
    fs.writeFileSync(file, `${asst({ input_tokens: 9, output_tokens: 2 })}\n`)
    const t = new TranscriptTokens()
    expect(await t.update("/linux/like", ["/no/such", file])).toEqual({ context: 9, output: 2 })
  })
})
