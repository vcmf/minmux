import { describe, it, expect } from "vitest"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { AgentHints } from "./agent-hints"

describe("AgentHints", () => {
  it("counts dismissals and remembers don't-ask-again", async () => {
    const h = new AgentHints(null)
    expect(await h.get("codex")).toEqual({ dismissals: 0, never: false })
    expect(await h.dismiss("codex", false)).toBe(1)
    await h.dismiss("codex", true)
    expect(await h.get("codex")).toEqual({ dismissals: 2, never: true })
  })
  it("persists across launches and survives a corrupt file", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "minmux-hints-"))
    const f = path.join(dir, "agent-hints.json")
    try {
      const h = new AgentHints(f)
      await h.dismiss("codex", false)
      await h.flushed()
      expect(await new AgentHints(f).get("codex")).toEqual({ dismissals: 1, never: false })
      fs.writeFileSync(f, "{not json")
      expect(await new AgentHints(f).get("codex")).toEqual({ dismissals: 0, never: false })
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
