// The Fleet view's cards and side panel (fleet-cards.tsx): what each kind of node and each PR or
// agent state shows, and what clicking does.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { fireEvent, render, screen } from "@testing-library/react"
import { FleetCard, FleetPanel, type NodeInfo } from "./fleet-cards"
import { ipc } from "../lib/ipc"
import { resetStore } from "../test/helpers"
import { DETACHED, type FleetAgent, type FleetPr, type FleetRepo } from "../lib/fleet-model"
import type { FleetNode } from "../lib/fleet-layout"
import type { PrRow } from "../lib/pr-dashboard"

const row = (over: Partial<PrRow>): PrRow =>
  ({ title: "T", state: "open", ci: null, review: "none", merge: "clean", ...over }) as PrRow
const pr = (n: number, over: Partial<PrRow> | null, state: FleetPr["state"] = "open"): FleetPr => ({
  url: `u/${n}`,
  number: n,
  state,
  ...(over ? { row: row({ number: n, title: `PR ${n}`, ...over }) } : {}),
  agents: [],
})
const agent = (over: Partial<FleetAgent> = {}): FleetAgent => ({
  id: "a",
  sessionId: "s",
  paneId: "p",
  kind: "claude",
  status: "working",
  subs: [],
  ...over,
})
const repo = (over: Partial<FleetRepo> = {}): FleetRepo => ({
  key: "o/r",
  label: "o/r",
  prs: [],
  branches: [],
  agents: [],
  counts: { agents: 1, working: 1, waiting: 0, prs: 0 },
  roots: [],
  ...over,
})
const node = (kind: FleetNode["kind"]): FleetNode => ({ id: kind, kind, x: 0, y: 0, w: 100, h: 40 })
const card = (kind: FleetNode["kind"], info: NodeInfo, over = {}) =>
  render(
    <FleetCard
      node={node(kind)}
      info={info}
      open={false}
      selected={false}
      onRoot={() => {}}
      onAgent={() => {}}
      {...over}
    />,
  )

describe("FleetCard", () => {
  beforeEach(() => resetStore())
  afterEach(() => vi.restoreAllMocks())

  it("a PR card says what holds it up, most pressing first", () => {
    const cases: [Partial<PrRow> | null, string][] = [
      [{ merge: "conflicts" }, "conflicts"],
      [{ ci: "failure" }, "CI failing"],
      [{ review: "changes" }, "changes requested"],
      [{ ci: "pending" }, "CI running"],
      [{ review: "approved" }, "✓ approved"],
      [{ state: "draft" }, "draft"],
      [{}, "ready"],
      [null, "open"],
    ]
    for (const [over, word] of cases) {
      const { unmount } = card("pr", { repo: repo(), pr: pr(1, over) })
      expect(screen.getByText(word)).toBeInTheDocument()
      unmount()
    }
    const { unmount } = card("pr", { repo: repo(), pr: pr(2, null, "draft") })
    expect(screen.getByText("draft")).toBeInTheDocument()
    unmount()
  })

  it("its link opens the PR on GitHub", () => {
    const open = vi.spyOn(ipc, "openExternal").mockResolvedValue(undefined as never)
    card("pr", { repo: repo(), pr: pr(3, {}) })
    fireEvent.click(screen.getByRole("button", { name: "Open #3 on GitHub" }))
    expect(open).toHaveBeenCalledWith("u/3")
  })

  it("a branch, a detached checkout, a sub-agent", () => {
    card("branch", { repo: repo(), branch: "feat/x" })
    expect(screen.getByText(/feat\/x/)).toBeInTheDocument()
    card("branch", { repo: repo(), branch: DETACHED })
    expect(screen.getByText(/detached HEAD/)).toBeInTheDocument()
    card("sub", { repo: repo(), sub: { id: "x", type: "Explore", status: "done" } })
    expect(screen.getByText(/Explore/)).toBeInTheDocument()
  })

  it("an agent: what it's doing; a click selects it", () => {
    const onAgent = vi.fn()
    for (const [a, word] of [
      [agent({ currentTool: "Bash" }), "running Bash"],
      [agent({ status: "waiting" }), "needs you"],
      [agent({ status: "idle", name: "fixer", kind: "codex" }), "idle"],
    ] as const) {
      const { unmount } = card("agent", { repo: repo(), agent: a }, { onAgent })
      expect(screen.getAllByText(new RegExp(word)).length).toBeGreaterThan(0)
      fireEvent.click(screen.getByRole("button"))
      unmount()
    }
    expect(onAgent).toHaveBeenCalledTimes(3)
  })

  it("a repo circle: its label and counts until it opens", () => {
    const onRoot = vi.fn()
    card("root", { repo: repo({ defaultBranch: "main" }) }, { onRoot })
    expect(screen.getByText(/⑂ main/)).toBeInTheDocument()
    expect(screen.getByText(/1 working/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Open o/r" }))
    expect(onRoot).toHaveBeenCalledWith("o/r")
  })

  it("nothing for a node it can't name", () => {
    const { container } = render(
      <FleetCard
        node={node("pr")}
        info={undefined}
        open={false}
        selected={false}
        onRoot={() => {}}
        onAgent={() => {}}
      />,
    )
    expect(container.innerHTML).toBe("")
  })
})

describe("FleetPanel", () => {
  beforeEach(() => resetStore())
  afterEach(() => vi.restoreAllMocks())

  const panel = (over: Partial<Parameters<typeof FleetPanel>[0]>) =>
    render(
      <FleetPanel
        repos={[]}
        open={null}
        sel={null}
        agentOf={() => undefined}
        onRepo={() => {}}
        onAgent={() => {}}
        onAll={() => {}}
        {...over}
      />,
    )

  it("an agent with no PR, sub-agents or tokens", () => {
    const a = agent({ status: "done" })
    panel({ sel: { kind: "agent", id: "a" }, agentOf: () => ({ repo: repo(), agent: a }) })
    expect(screen.getByText("Sub-agents · 0")).toBeInTheDocument()
    expect(screen.getAllByText("none").length).toBeGreaterThan(0)
  })

  it("a repo with no open PR; its GitHub link", () => {
    const open = vi.spyOn(ipc, "openExternal").mockResolvedValue(undefined as never)
    const r = repo({ repo: "o/r", agents: [agent()] })
    panel({ repos: [r], sel: { kind: "repo", key: "o/r" } })
    expect(screen.getByText("none open")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: /Open on GitHub/ }))
    expect(open).toHaveBeenCalledWith("https://github.com/o/r")
  })
})
