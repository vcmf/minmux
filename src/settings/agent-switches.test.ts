import { describe, it, expect } from "vitest"
import { defaultAgentSwitches, disabledAgentsIn, mergeAgentSwitches } from "./agent-switches"
import { AGENT_KINDS } from "../lib/agent-kinds"

describe("agent switches", () => {
  it("default every known agent on", () => {
    expect(Object.keys(defaultAgentSwitches())).toEqual(Object.keys(AGENT_KINDS))
    expect(disabledAgentsIn(defaultAgentSwitches()).size).toBe(0)
  })
  it("take booleans for known agents only", () => {
    const s = mergeAgentSwitches({ codex: { enabled: false }, claude: { enabled: 1 }, x: {} })
    expect([...disabledAgentsIn(s)]).toEqual(["codex"])
    expect(s).not.toHaveProperty("x")
    expect(mergeAgentSwitches("junk")).toEqual(defaultAgentSwitches())
  })
})
