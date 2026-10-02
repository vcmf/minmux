import { describe, it, expect } from "vitest"
import { ACCENT_COLORS, sessionColor, sessionColorName } from "./session-color"

describe("sessionColorName", () => {
  it("an explicit /color wins (even over a name)", () => {
    expect(sessionColorName({ color: "orange", name: "anything" })).toBe("orange")
  })

  it("a reset (/color default) means no colour, even for a named session", () => {
    expect(sessionColorName({ color: null, name: "named" })).toBeUndefined()
  })

  it("a renamed session without /color gets a stable colour from its name", () => {
    const a = sessionColorName({ name: "add-multi-windows-per-tab" })
    expect(ACCENT_COLORS).toContain(a)
    expect(sessionColorName({ name: "add-multi-windows-per-tab" })).toBe(a) // stable
    expect(sessionColorName({ name: "  add-multi-windows-per-tab  " })).toBe(a) // trimmed
  })

  it("names spread across the palette (not all one colour)", () => {
    const names = Array.from({ length: 40 }, (_, i) => `session-${i}`)
    const used = new Set(names.map((n) => sessionColorName({ name: n })))
    expect(used.size).toBeGreaterThanOrEqual(6)
  })

  it("no meta, no name, or an unknown colour → none", () => {
    expect(sessionColorName(undefined)).toBeUndefined()
    expect(sessionColorName({})).toBeUndefined()
    expect(sessionColorName({ name: "   " })).toBeUndefined()
    expect(sessionColorName({ color: "chartreuse" })).toBeUndefined()
  })
})

describe("sessionColor", () => {
  it("maps to a per-scheme swatch", () => {
    const dark = sessionColor({ color: "blue" }, "dark")
    const light = sessionColor({ color: "blue" }, "light")
    expect(dark).toMatch(/^#[0-9a-f]{6}$/)
    expect(light).toMatch(/^#[0-9a-f]{6}$/)
    expect(dark).not.toBe(light) // light themes get a deeper swatch
  })

  it("every Claude colour has a swatch in both schemes", () => {
    for (const c of ACCENT_COLORS) {
      expect(sessionColor({ color: c }, "dark")).toBeTruthy()
      expect(sessionColor({ color: c }, "light")).toBeTruthy()
    }
  })
})
