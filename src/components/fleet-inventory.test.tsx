// The Fleet inventory view (fleet-inventory.tsx): Live from the open sessions, the history
// windows from main, a used row picking the sessions that used it.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { fireEvent, render, screen } from "@testing-library/react"
import { FleetInventory } from "./fleet-inventory"
import { ipc } from "../lib/ipc"
import { resetStore } from "../test/helpers"
import type { FleetAgent } from "../lib/fleet-model"

const agent = (id: string, toolbox: FleetAgent["toolbox"], kind: FleetAgent["kind"] = "claude") =>
  ({ id, sessionId: id, paneId: "p", kind, status: "idle", subs: [], toolbox }) as FleetAgent

describe("FleetInventory", () => {
  beforeEach(() => resetStore())
  afterEach(() => vi.restoreAllMocks())

  it("Live: the open sessions' uses; a used row picks the sessions that used it", () => {
    const onPick = vi.fn()
    const unused = Array.from({ length: 10 }, (_, i) => `u${i}`)
    render(
      <FleetInventory
        agents={[
          agent("a", { mcp: { gh: 2 }, mcpLoaded: ["gh", ...unused], skills: {} }),
          agent("b", { mcp: {}, skills: null }, "codex"),
        ]}
        onPick={onPick}
      />,
    )
    expect(screen.getByText("2 calls")).toBeInTheDocument()
    expect(screen.getByText("not supported yet")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: /^gh/ }))
    expect(onPick).toHaveBeenCalledWith(["a"], "Claude · gh")
    fireEvent.click(screen.getByText("+2 more unused"))
    expect(screen.getByText("u9")).toBeInTheDocument()
    fireEvent.click(screen.getByText("fewer"))
  })

  it("a window reads the history; one that fails says so", async () => {
    const today = new Date().toISOString().slice(0, 10)
    const spy = vi.spyOn(ipc, "fleetInventory").mockResolvedValue({
      claude: {
        days: { [today]: { mcp: { old: 4 }, skills: {} } },
        loaded: {},
        mcpNow: ["old"],
        skillsNow: [],
      },
    })
    render(<FleetInventory agents={[]} onPick={() => {}} />)
    fireEvent.click(screen.getByRole("button", { name: "7 days" }))
    expect(await screen.findByText("4 calls")).toBeInTheDocument()
    // (no open session used it: nothing to show on the graph)
    expect(screen.getByRole("button", { name: /^old/ })).toBeDisabled()
    expect(spy).toHaveBeenCalledTimes(1)
    spy.mockResolvedValue(null)
  })

  it("history that can't be read", async () => {
    vi.spyOn(ipc, "fleetInventory").mockResolvedValue(null)
    render(<FleetInventory agents={[]} onPick={() => {}} />)
    fireEvent.click(screen.getByRole("button", { name: "All" }))
    expect(await screen.findByText("history can't be read right now")).toBeInTheDocument()
  })
})
