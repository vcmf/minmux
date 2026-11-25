// The Fleet view's camera, edges and panel states (fleet-view.tsx): panning by wheel, keys and
// drag, the edges drawn through the camera, the dock, and what the side panel shows.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { FleetView } from "./fleet-view"
import { useStore } from "../store"
import { ipc } from "../lib/ipc"
import { reduceAgentEvents } from "../lib/agent-graph"
import { resetStore, testShell } from "../test/helpers"
import type { PrRow } from "../lib/pr-dashboard"

const row = (n: number, repo = "o/r", over: Partial<PrRow> = {}): PrRow =>
  ({
    number: n,
    title: `PR ${n}`,
    url: `https://github.com/${repo}/pull/${n}`,
    repo,
    defaultBranch: "main",
    state: "open",
    ci: "failure",
    ...over,
  }) as PrRow

const session = (id: string, cwd: string) => ({
  id,
  title: "zsh",
  command: testShell.command,
  args: [],
  cwd,
  status: "idle" as const,
  unread: false,
})

// Two repos: o/r (pane p1 on PR 7, two sub-agents, tokens) and o/b (pane p2 on main).
function seed() {
  useStore.setState({
    sessions: { p1: session("p1", "/w/r"), p2: session("p2", "/w/b") },
    agents: reduceAgentEvents([
      { event: "SessionStart", sessionId: "s1", cwd: "/w/r", paneId: "p1" },
      { event: "UserPromptSubmit", sessionId: "s1" },
      { event: "SubagentStart", sessionId: "s1", agentId: "x1", agentType: "Explore" },
      {
        event: "TokenUsage",
        sessionId: "s1",
        tokens: { context: 170_000, output: 9_000, window: 200_000 },
      },
      {
        event: "Toolbox",
        sessionId: "s1",
        toolbox: {
          mcp: { notion: 3 },
          mcpLoaded: ["notion", "hexgate", "gh"],
          mcpDown: ["hexgate"],
          skills: { review: 1 },
          skillsLoaded: ["review", "a", "b", "c", "d", "e", "f"],
        },
      },
      { event: "SessionStart", sessionId: "s2", cwd: "/w/b", paneId: "p2" },
      { event: "UserPromptSubmit", sessionId: "s2" },
      { event: "PermissionRequest", sessionId: "s2", toolName: "Bash" },
    ]),
    paneGit: {
      p1: {
        root: "/w/r",
        branch: "feat",
        pr: { number: 7, state: "open", url: "https://github.com/o/r/pull/7" },
      },
      p2: { root: "/w/b", branch: "main" },
    },
  })
}

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

const layer = () => document.querySelector<HTMLElement>(".fleet-layer")!
const viewport = () => document.querySelector<HTMLElement>(".fleet-viewport")!
const panel = () => document.querySelector<HTMLElement>(".fleet-panel")!
const frame = () => act(async () => void (await new Promise((r) => setTimeout(r, 30))))

describe("FleetView: camera, edges, panel", () => {
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
          worktrees: [{ path: "/w/r", branch: "feat" }],
          roots: ["/w/r"],
        },
        {
          repo: "o/b",
          defaultBranch: "main",
          worktrees: [{ path: "/w/b", branch: "main" }],
          roots: ["/w/b"],
        },
      ],
    })
    vi.spyOn(ipc, "prLists").mockResolvedValue({
      ok: true,
      lists: { mine: [row(7), row(9, "o/r", { state: "draft", ci: null })], review: [] },
    })
  })
  afterEach(() => vi.restoreAllMocks())

  it("pans with the wheel, the keys and a drag; Home brings it back", async () => {
    stubCanvas()
    seed()
    render(<FleetView />)
    await screen.findByRole("button", { name: "Open o/r" })
    await frame()
    const at = () => layer().style.transform
    const start = at()
    fireEvent.wheel(viewport(), { deltaX: 120, deltaY: 0 })
    await frame()
    const wheeled = at()
    expect(wheeled).not.toBe(start)
    fireEvent.wheel(viewport(), { deltaY: 10, ctrlKey: true }) // a pinch: no pan
    await frame()
    expect(at()).toBe(wheeled)
    fireEvent.keyDown(viewport(), { key: "ArrowDown" })
    await frame()
    expect(at()).not.toBe(wheeled)
    fireEvent.keyDown(viewport(), { key: "Home" })
    await act(async () => void (await new Promise((r) => setTimeout(r, 450))))
    expect(at()).toBe(start)
    // A drag on empty space pans; a lost capture ends it.
    fireEvent.pointerDown(viewport(), { button: 0, clientX: 100, clientY: 100, pointerId: 1 })
    fireEvent.pointerMove(viewport(), { clientX: 60, clientY: 100, pointerId: 1, buttons: 1 })
    await frame()
    expect(at()).not.toBe(start)
    expect(viewport().classList.contains("panning")).toBe(true)
    fireEvent(viewport(), new Event("lostpointercapture"))
    expect(viewport().classList.contains("panning")).toBe(false)
  })

  it("draws the edges through the camera", async () => {
    const calls = stubCanvas()
    seed()
    render(<FleetView />)
    fireEvent.click(await screen.findByRole("button", { name: "Open o/r" }))
    await screen.findAllByText("PR 7")
    await frame()
    expect(calls.filter((c) => c.startsWith("lineTo")).length).toBeGreaterThan(1)
    expect(calls).toContain("setTransform(6)")
  })

  it("the panel: all repos, one repo with its PRs, one agent with its context; the dock switches", async () => {
    stubCanvas()
    seed()
    render(<FleetView />)
    // All repos: a row opens one.
    fireEvent.click(await screen.findByRole("button", { name: /^o\/b/ }))
    expect(await screen.findByRole("heading", { name: "o/b" })).toBeInTheDocument()
    // The dock: the other repo opens from it.
    fireEvent.click(await screen.findByTitle("Open o/r"))
    expect(await screen.findByRole("heading", { name: "o/r" })).toBeInTheDocument()
    expect(screen.getAllByText("CI failing").length).toBeGreaterThan(0)
    expect(screen.getAllByText("draft").length).toBeGreaterThan(0)
    // An agent: its context and sub-agents.
    fireEvent.click(screen.getByRole("button", { name: /^Claude agent/ }))
    expect(await screen.findByText("Sub-agents · 1")).toBeInTheDocument()
    expect(screen.getByText(/170k \/ 200k/)).toBeInTheDocument()
    // Its MCP servers and skills: used, failed, unused, and the rest folded.
    expect(within(panel()).getByText("used 1 / 3")).toBeInTheDocument()
    expect(within(panel()).getByText("· 3 calls")).toBeInTheDocument()
    expect(within(panel()).getByText("· failed to start")).toBeInTheDocument()
    expect(within(panel()).getByText("used 1 / 7")).toBeInTheDocument()
    expect(within(panel()).getByText("+2 loaded, unused")).toBeInTheDocument()
    // Back to the repo, then all repos.
    fireEvent.click(screen.getByRole("button", { name: /← o\/r/ }))
    await screen.findByRole("heading", { name: "o/r" })
    fireEvent.click(screen.getByRole("button", { name: "← all repos" }))
    await waitFor(() => expect(screen.getByText("Repos · 2")).toBeInTheDocument())
  })

  it("dragging a card pins it there (its click doesn't fire); Unpin lets it go", async () => {
    stubCanvas()
    seed()
    render(<FleetView />)
    fireEvent.click(await screen.findByRole("button", { name: "Open o/r" }))
    await screen.findAllByText("PR 7")
    await act(async () => void (await new Promise((r) => setTimeout(r, 600)))) // grown out
    const card = document.querySelector<HTMLElement>(".fleet-agent")!
    const at = () => [card.style.left, card.style.top].join()
    const before = at()
    // A small wobble is still a click: no pin.
    fireEvent.pointerDown(card, { button: 0, clientX: 100, clientY: 100, pointerId: 2 })
    fireEvent.pointerMove(viewport(), { clientX: 102, clientY: 101, pointerId: 2, buttons: 1 })
    fireEvent.pointerUp(viewport(), { clientX: 102, clientY: 101, pointerId: 2 })
    expect(screen.queryByText("Unpin")).toBeNull()
    // A drag moves it, and stays.
    fireEvent.pointerDown(card, { button: 0, clientX: 100, clientY: 100, pointerId: 3 })
    fireEvent.pointerMove(viewport(), { clientX: 160, clientY: 130, pointerId: 3, buttons: 1 })
    fireEvent.pointerUp(viewport(), { clientX: 160, clientY: 130, pointerId: 3 })
    fireEvent.click(card) // (the click that ends a drag)
    await frame()
    expect(at()).not.toBe(before)
    fireEvent.click(await screen.findByText("Unpin"))
    await frame()
    expect(screen.queryByText("Unpin")).toBeNull()
    expect(at()).toBe(before)
  })
})
