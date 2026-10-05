import { describe, it, expect } from "vitest"
import { sessionMenuItems } from "./session-menu"

describe("sessionMenuItems", () => {
  it("offers Rename, Reset name and Close session, in that order", () => {
    expect(sessionMenuItems({ title: "work" }).map((i) => i.id)).toEqual([
      "rename",
      "resetName",
      "close",
    ])
  })

  it("enables Reset only for a name the user gave", () => {
    const named = sessionMenuItems({ title: "work" }).find((i) => i.id === "resetName")!
    expect(named.disabled).toBe(false)
    expect(named.hint).toBeUndefined()
    const unnamed = sessionMenuItems({ title: "" }).find((i) => i.id === "resetName")!
    expect(unnamed.disabled).toBe(true)
    expect(unnamed.hint).toBe("not renamed")
  })

  it("treats a whitespace-only title as unnamed (it displays the live title)", () => {
    expect(sessionMenuItems({ title: "   " }).find((i) => i.id === "resetName")!.disabled).toBe(
      true,
    )
  })

  it("separates Close from the naming actions", () => {
    const items = sessionMenuItems({ title: "" })
    expect(items.find((i) => i.id === "close")!.separatorBefore).toBe(true)
    expect(items.filter((i) => i.separatorBefore)).toHaveLength(1)
  })
})
