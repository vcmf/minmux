import { beforeEach, describe, expect, it } from "vitest"
import { fireEvent, render, screen } from "@testing-library/react"
import { AgentHint } from "./agent-hint"
import { useStore } from "../store"
import { ipc } from "../lib/ipc"
import { resetStore, testShell } from "../test/helpers"

const st = () => useStore.getState()
const pane = () => st().tabs[0]!.activeSessionId

describe("AgentHint", () => {
  beforeEach(() => {
    resetStore()
    st().setShells([testShell])
    st().newTab(testShell)
  })

  it("shows only on the pane it was raised for, naming the agent and the one step", () => {
    st().setAgentHint(pane(), { kind: "codex", dismissals: 0 })
    const { container } = render(<AgentHint sessionId="someone-else" />)
    expect(container).toBeEmptyDOMElement()
    render(<AgentHint sessionId={pane()} />)
    const text = screen.getByRole("status").textContent!
    expect(text).toContain("Approve minmux in Codex")
    expect(text).toContain("/hooks")
    expect(screen.queryByText("Don't ask again")).toBeNull() // not before a few dismissals
  })

  it("Show me copies /hooks and never types into the pane", () => {
    st().setAgentHint(pane(), { kind: "codex", dismissals: 0 })
    render(<AgentHint sessionId={pane()} />)
    fireEvent.click(screen.getByText("Show me"))
    expect(ipc.clipboardWrite).toHaveBeenCalledWith("/hooks")
    expect(ipc.ptyWrite).not.toHaveBeenCalled()
    expect(screen.getByRole("status").textContent).toContain("Copied /hooks.")
  })

  it("Not now hides it and counts; after a few, Don't ask again is offered", () => {
    st().setAgentHint(pane(), { kind: "codex", dismissals: 3 })
    render(<AgentHint sessionId={pane()} />)
    fireEvent.click(screen.getByText("Don't ask again"))
    expect(ipc.agentHintDismiss).toHaveBeenCalledWith("codex", true)
    expect(st().agentHint[pane()]).toBeUndefined()
  })
})
