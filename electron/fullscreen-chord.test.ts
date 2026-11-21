import { describe, expect, it } from "vitest"
import { isFullScreenChord, type ChordInput } from "./fullscreen-chord"

const k = (key: string, mods: Partial<ChordInput> = {}): ChordInput => ({
  key,
  control: false,
  meta: false,
  alt: false,
  shift: false,
  ...mods,
})

describe("isFullScreenChord", () => {
  it("macOS: ctrl+cmd+F only", () => {
    expect(isFullScreenChord(k("f", { control: true, meta: true }), "darwin")).toBe(true)
    expect(isFullScreenChord(k("F", { control: true, meta: true }), "darwin")).toBe(true)
    expect(isFullScreenChord(k("f", { meta: true }), "darwin")).toBe(false) // ⌘F = find
    expect(isFullScreenChord(k("f", { control: true }), "darwin")).toBe(false) // readline
    expect(isFullScreenChord(k("F11"), "darwin")).toBe(false)
  })

  it("Windows / Linux: bare F11", () => {
    expect(isFullScreenChord(k("F11"), "win32")).toBe(true)
    expect(isFullScreenChord(k("F11"), "linux")).toBe(true)
    expect(isFullScreenChord(k("F11", { shift: true }), "linux")).toBe(false)
    expect(isFullScreenChord(k("f", { control: true, meta: true }), "win32")).toBe(false)
  })
})
