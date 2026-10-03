import { describe, it, expect } from "vitest"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { UserNames } from "./agent-names"

describe("UserNames", () => {
  it("keeps the sessions the user named, across launches", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "minmux-names-"))
    const f = path.join(dir, "agent-names.json")
    try {
      const n = new UserNames(f)
      await n.loaded
      expect(n.has("ses_a")).toBeUndefined()
      n.set("ses_a", true)
      n.set("ses_b", true)
      n.set("ses_b", false) // a name that's no longer the user's
      await n.flushed()
      const after = new UserNames(f)
      await after.loaded
      expect(after.has("ses_a")).toBe(true)
      expect(after.has("ses_b")).toBeUndefined()
      fs.writeFileSync(f, "{not json")
      const bad = new UserNames(f)
      await bad.loaded
      expect(bad.has("ses_a")).toBeUndefined() // unreadable: nothing known
      fs.writeFileSync(f, JSON.stringify({ v: 1, sessions: ["ses_c", 7, null] }))
      const junk = new UserNames(f)
      await junk.loaded
      expect(junk.has("ses_c")).toBe(true) // junk skipped
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("a name recorded before the file is read is kept (it's newer)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "minmux-names-"))
    const f = path.join(dir, "agent-names.json")
    try {
      fs.writeFileSync(f, JSON.stringify({ v: 1, sessions: ["ses_old"] }))
      const n = new UserNames(f)
      n.set("ses_new", true) // before the load lands
      await n.loaded
      expect(n.has("ses_old")).toBe(true)
      expect(n.has("ses_new")).toBe(true)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("a session named again moves to the back: the one named longest ago goes first", () => {
    const n = new UserNames(null)
    n.set("ses_main", true)
    for (let i = 0; i < 999; i++) n.set(`ses_${i}`, true) // 1000 in all
    n.set("ses_main", true) // renamed again
    n.set("ses_last", true) // full: one goes
    expect(n.has("ses_main")).toBe(true)
    expect(n.has("ses_0")).toBeUndefined()
  })
})
