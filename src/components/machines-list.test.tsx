import { beforeEach, describe, expect, it } from "vitest"
import { act, fireEvent, render, screen } from "@testing-library/react"
import { MachinesList } from "./machines-list"
import { useMachines } from "../lib/machines-store"
import { ipc } from "../lib/ipc"
import { useStore } from "../store"
import { resetStore, testShell } from "../test/helpers"

const panes = {
  tabs: [
    { id: "t1", title: "work" },
    { id: "t2", title: "play" },
  ],
  panes: [
    {
      id: "p1",
      tab: "t1",
      title: "claude",
      kind: "agent" as const,
      status: "waiting" as const,
      started: true,
      cwd: "~/repo",
    },
    {
      id: "p2",
      tab: "t2",
      title: "zsh",
      kind: "shell" as const,
      status: "working" as const,
      started: true,
    },
    {
      id: "p3",
      tab: "t2",
      title: "later",
      kind: "shell" as const,
      status: "idle" as const,
      started: false,
    },
  ],
  stale: false,
}

describe("MachinesList", () => {
  beforeEach(() => {
    resetStore()
    useMachines.getState().set([])
  })

  it("lists machines only while shown, and nothing when none", () => {
    const { unmount, container } = render(<MachinesList />)
    expect(ipc.machinesList).toHaveBeenLastCalledWith(true)
    expect(container.textContent).toBe("")
    unmount()
    expect(ipc.machinesList).toHaveBeenLastCalledWith(false)
  })

  it("asks for access; shows the code while asking", () => {
    render(<MachinesList />)
    act(() => useMachines.getState().set([{ key: "linux:7420", label: "linux", state: "new" }]))
    fireEvent.click(screen.getByText("Ask for access"))
    expect(ipc.machinesPair).toHaveBeenCalledWith("linux:7420")
    act(() =>
      useMachines
        .getState()
        .set([{ key: "linux:7420", label: "linux", state: "pairing", code: "QX7P" }]),
    )
    expect(screen.getByText(/QX7P/)).toBeInTheDocument()
    act(() => useMachines.getState().set([{ key: "linux:7420", label: "linux", state: "locked" }]))
    expect(screen.getByText("Ask again")).toBeInTheDocument()
  })

  it("a connected machine's panes by tab: one opens as a surface here, once", () => {
    useStore.getState().newTab(testShell)
    render(<MachinesList />)
    act(() =>
      useMachines
        .getState()
        .set([
          { key: "linux:7420", label: "linux", state: "connected", permission: "keys", panes },
        ]),
    )
    expect(screen.getByText("work")).toBeInTheDocument()
    expect(screen.getByText("later").closest("button")).toBeDisabled()
    fireEvent.click(screen.getByText("claude"))
    const sessions = () => Object.values(useStore.getState().sessions).filter((s) => s.peer)
    expect(sessions()).toHaveLength(1)
    expect(sessions()[0]).toMatchObject({
      title: "claude · linux",
      peer: { key: "linux:7420", pane: "p1", machine: "linux" },
    })
    const tab = useStore.getState().tabs[0]!
    expect(tab.activeEntryId).toBe(sessions()[0]!.id)
    // Already open: shown again, not opened twice.
    useStore.getState().newSurface()
    fireEvent.click(screen.getByText("claude"))
    expect(sessions()).toHaveLength(1)
    expect(useStore.getState().tabs[0]!.activeEntryId).toBe(sessions()[0]!.id)
    // A new terminal beside it is a local shell (the default), not a copy of "no command".
    useStore.getState().splitActive("row")
    const split = useStore.getState().sessions[useStore.getState().tabs[0]!.activeSessionId]!
    expect(split.peer).toBeUndefined()
    expect(split.command).toBe(testShell.command)
    // Collapsing the machine hides its panes.
    fireEvent.click(screen.getByText("linux"))
    expect(screen.queryByText("claude")).toBeNull()
  })

  it("a connected machine with no panes says so", () => {
    render(<MachinesList />)
    act(() =>
      useMachines.getState().set([
        {
          key: "linux:7420",
          label: "linux",
          state: "connected",
          permission: "view",
          panes: { tabs: [], panes: [], stale: false },
        },
      ]),
    )
    expect(screen.getByText("No panes open")).toBeInTheDocument()
    expect(screen.getByText("View only")).toBeInTheDocument()
  })
})
