import { describe, expect, it } from "vitest"
import { TurnTracker } from "./turns"

type E = Parameters<TurnTracker["apply"]>[0]
const P = "p"
const run = (t: TurnTracker, ...evs: Partial<E>[]) => {
  for (const e of evs) t.apply({ paneId: P, event: "x", ...e } as E)
  return t.turn(P)
}

describe("turn tracker", () => {
  it("unknown counts as working; a fresh session or Stop is between", () => {
    const t = new TurnTracker()
    expect(t.turn(P)).toBe("working")
    expect(run(t, { event: "SessionStart" })).toBe("between")
    expect(run(t, { event: "UserPromptSubmit" })).toBe("working")
    expect(
      run(
        t,
        { event: "PreToolUse" },
        { event: "Notification", notificationType: "permission_prompt" },
      ),
    ).toBe("working")
    expect(run(t, { event: "PostToolUse" }, { event: "Stop" })).toBe("between")
  })

  it("the idle reminder is between; a sub-agent's Stop is not", () => {
    const t = new TurnTracker()
    expect(run(t, { event: "Notification", notificationType: "idle_prompt" })).toBe("between")
    expect(run(t, { event: "Notification", message: "Claude is waiting for your input" })).toBe(
      "between",
    )
    expect(run(t, { event: "SubagentStart", agentId: "a" })).toBe("working")
    expect(run(t, { event: "Stop", agentId: "a" })).toBe("working")
  })

  it("a session end or the pane closing forgets it (working)", () => {
    const t = new TurnTracker()
    run(t, { event: "Stop" })
    expect(run(t, { event: "SessionEnd" })).toBe("working")
    run(t, { event: "Stop" })
    t.drop(P)
    expect(t.turn(P)).toBe("working")
    t.apply({ event: "Stop" } as E) // no pane: ignored
  })
})
