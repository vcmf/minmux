import { describe, it, expect } from "vitest"
import { render } from "@testing-library/react"
import { agentIcon } from "./agent-icon"
import { AGENT_KINDS } from "../lib/agent-kinds"
import type { AgentKind } from "../lib/agent-graph"

describe("agentIcon", () => {
  it("draws each agent's own mark in the colour it's given (its accent)", () => {
    for (const kind of Object.keys(AGENT_KINDS) as AgentKind[]) {
      const Icon = agentIcon(kind)
      const { container, unmount } = render(<Icon size={13} color="rgb(240, 145, 61)" />)
      const svg = container.querySelector("svg")!
      expect(svg.getAttribute("data-icon")).toBe(kind)
      expect(svg.getAttribute("width")).toBe("13")
      expect(svg.style.color).toBe("rgb(240, 145, 61)")
      unmount()
    }
  })
})
