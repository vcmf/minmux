// The Fleet view's stacked PRs (fleet-view.tsx): a stacked PR's edge curves to the PR it's on and
// ends in an arrow. Its own file: the fleet's data refresher is one per module, and the camera
// tests' lists have no stack.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { act, fireEvent, render, screen } from "@testing-library/react"
import { FleetView } from "./fleet-view"
import { useStore } from "../store"
import { ipc } from "../lib/ipc"
import { reduceAgentEvents } from "../lib/agent-graph"
import { resetStore, testShell } from "../test/helpers"
import type { PrRow } from "../lib/pr-dashboard"

const row = (n: number, over: Partial<PrRow>): PrRow =>
  ({
    number: n,
    title: `PR ${n}`,
    url: `https://github.com/o/r/pull/${n}`,
    repo: "o/r",
    defaultBranch: "main",
    state: "open",
    ci: "success",
    ...over,
  }) as PrRow

// A canvas context that records what's drawn (jsdom has none).
function stubCanvas() {
  const calls: string[] = []
  const ctx = new Proxy(
    {},
    {
      get: (_t, k) =>
        typeof k === "string" && /^[a-z]/.test(k)
          ? (...a: unknown[]) => void calls.push(`${k}(${a.length})`)
          : undefined,
      set: () => true,
    },
  )
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(ctx as never)
  return calls
}

const frame = () => act(async () => void (await new Promise((r) => setTimeout(r, 30))))

describe("FleetView: stacked PRs", () => {
  beforeEach(() => {
    resetStore()
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) =>
      Number(setTimeout(() => cb(performance.now()), 0)),
    )
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => clearTimeout(id))
    vi.spyOn(ipc, "prLocal").mockResolvedValue({
      ok: true,
      repos: [
        {
          repo: "o/r",
          defaultBranch: "main",
          worktrees: [{ path: "/w/r", branch: "top" }],
          roots: ["/w/r"],
        },
      ],
    })
    vi.spyOn(ipc, "prLists").mockResolvedValue({
      ok: true,
      lists: {
        mine: [row(7, { head: "feat", base: "main" }), row(9, { head: "top", base: "feat" })],
        review: [],
      },
    })
  })
  afterEach(() => vi.restoreAllMocks())

  it("a stacked PR's edge curves to the PR it's on and ends in an arrow, the selected one too", async () => {
    const calls = stubCanvas()
    useStore.setState({
      sessions: {
        p1: {
          id: "p1",
          title: "zsh",
          command: testShell.command,
          args: [],
          cwd: "/w/r",
          status: "idle",
          unread: false,
        },
      },
      agents: reduceAgentEvents([
        { event: "SessionStart", sessionId: "s1", cwd: "/w/r", paneId: "p1" },
        { event: "UserPromptSubmit", sessionId: "s1" },
      ]),
      paneGit: {
        p1: {
          root: "/w/r",
          forCwd: "/w/r",
          branch: "top",
          pr: { number: 9, state: "open", url: "https://github.com/o/r/pull/9" },
        },
      },
    })
    render(<FleetView />)
    fireEvent.click(await screen.findByRole("button", { name: "Open o/r" }))
    await screen.findByText(/on #7/)
    await frame()
    // (only an arrow closes a path)
    expect(calls).toContain("bezierCurveTo(6)")
    expect(calls).toContain("closePath(0)")
    calls.length = 0
    fireEvent.click(screen.getByRole("button", { name: /^Claude agent/ })) // (its path: green)
    await frame()
    expect(calls).toContain("closePath(0)")
  })
})
