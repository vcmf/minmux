import { describe, expect, it } from "vitest"
import { machineLine, panesByTab, type MachineView } from "./remote-machines"

describe("machines list helpers", () => {
  it("groups panes by tab, in tab order, empty tabs left out", () => {
    const g = panesByTab({
      tabs: [
        { id: "t1", title: "one" },
        { id: "t2", title: "two" },
        { id: "t3", title: "empty" },
      ],
      panes: [
        { id: "b", tab: "t2", title: "b", kind: "shell", status: "idle", started: true },
        { id: "a", tab: "t1", title: "a", kind: "shell", status: "idle", started: true },
      ],
      stale: false,
    })
    expect(g.map((x) => [x.title, x.panes.map((p) => p.id)])).toEqual([
      ["one", ["a"]],
      ["two", ["b"]],
    ])
  })

  it("says what each state means", () => {
    const m = (state: MachineView["state"], extra: Partial<MachineView> = {}): MachineView => ({
      key: "k",
      label: "l",
      state,
      ...extra,
    })
    expect(machineLine(m("pairing", { code: "AB12" }))).toContain("AB12")
    expect(machineLine(m("pairing"))).toContain("…")
    expect(machineLine(m("connected", { permission: "keys" }))).toBe("")
    expect(machineLine(m("connected", { permission: "view" }))).toBe("View only")
    for (const s of ["new", "connecting", "locked", "denied", "offline"] as const)
      expect(machineLine(m(s))).not.toBe("")
  })
})
