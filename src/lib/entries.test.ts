import { describe, it, expect } from "vitest"
import { isTerminalEntry, OBJECT_PREFIX } from "./entries"

describe("entries", () => {
  it("a session id is a terminal entry", () => {
    expect(isTerminalEntry(crypto.randomUUID())).toBe(true)
    expect(isTerminalEntry("a")).toBe(true)
  })

  it("an object id is not", () => {
    expect(isTerminalEntry(`${OBJECT_PREFIX}${crypto.randomUUID()}`)).toBe(false)
  })
})
