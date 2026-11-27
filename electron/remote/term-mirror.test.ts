// @vitest-environment node
import { describe, expect, it } from "vitest"
import { TermMirror } from "./term-mirror"

describe("TermMirror", () => {
  it("starts from a snapshot and follows batches in order", async () => {
    const m = new TermMirror({ epoch: 1, offset: 5, cols: 20, rows: 4, text: "hello" })
    expect(m.write(1, 5, " world")).toBe("ok")
    expect(await m.serialize()).toContain("hello world")
    expect(m.write(1, 5, "again")).toBe("gap") // already taken
    expect(m.write(1, 99, "x")).toBe("gap") // a hole
    expect(m.write(2, 11, "x")).toBe("gap") // a reattach
    m.resize(30, 6)
    expect([m.cols, m.rows]).toEqual([30, 6])
    m.dispose()
  })

  it("keeps colours and the cursor (no raw replay)", async () => {
    const m = new TermMirror({ epoch: 1, offset: 0, cols: 20, rows: 3, text: "" })
    m.write(1, 0, "\x1b[31mred\x1b[0m\r\n\x1b[2Jcleared")
    const s = await m.serialize()
    expect(s).toContain("cleared")
    expect(s).not.toContain("\x1b[2J")
  })
})
