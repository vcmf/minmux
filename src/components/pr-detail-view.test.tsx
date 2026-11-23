import { describe, it, expect, beforeEach, vi } from "vitest"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { PrDetailView } from "./pr-detail-view"
import { ipc } from "../lib/ipc"
import type { PrRow } from "../lib/pr-dashboard"
import type { PrDetail } from "../lib/pr-detail"

const row = (n: number, updatedAt = "t1"): PrRow => ({
  number: n,
  title: `PR ${n}`,
  url: `https://github.com/o/r/pull/${n}`,
  repo: "o/r",
  author: "me",
  state: "open",
  head: "b",
  fork: false,
  base: "main",
  review: null,
  reviewers: [],
  requested: [],
  merge: "clean",
  ci: null,
  comments: 0,
  additions: 0,
  deletions: 0,
  updatedAt,
})

const detail = (n: number, over: Partial<PrDetail> = {}): PrDetail => ({
  url: row(n).url,
  updatedAt: "t1",
  body: "The description, see https://x.io",
  conversation: [
    { kind: "review", author: "alice", body: "Looks good", at: "", url: "r1", state: "approved" },
  ],
  threads: [
    {
      path: "src/a.ts",
      line: 12,
      resolved: false,
      outdated: false,
      removed: false,
      hunk: "@@ -1 +1 @@\n-old\n+new",
      comments: [{ author: "bob", body: "Rename this?", at: "", url: "c1" }],
    },
    {
      path: "src/a.ts",
      line: 3,
      resolved: true,
      outdated: false,
      removed: false,
      hunk: "",
      comments: [{ author: "bob", body: "Done", at: "", url: "c2" }],
    },
  ],
  more: false,
  links: { closes: [], mentions: [], mentionedBy: [] },
  ...over,
})

beforeEach(() => vi.clearAllMocks())

describe("PrDetailView", () => {
  it("description, review threads by file with their lines, and the conversation", async () => {
    vi.mocked(ipc.prDetail).mockResolvedValue({ ok: true, detail: detail(1) })
    render(<PrDetailView row={row(1)} cwd="/w" />)
    expect(await screen.findByText("Rename this?")).toBeInTheDocument()
    expect(ipc.prDetail).toHaveBeenCalledWith({ repo: "o/r", number: 1, cwd: "/w", wsl: undefined })
    expect(screen.getByText(/Review threads \(2, 1 open\)/)).toBeInTheDocument()
    expect(screen.getByText("+new")).toBeInTheDocument()
    expect(screen.getByText("Looks good")).toBeInTheDocument()
    fireEvent.click(await screen.findByText("https://x.io")) // rendered: a link
    expect(ipc.openExternal).toHaveBeenCalledWith("https://x.io")
  })

  it("open in the editor at the thread's line, when this PR's repo is checked out", async () => {
    vi.mocked(ipc.prDetail).mockResolvedValue({ ok: true, detail: detail(2) })
    vi.mocked(ipc.pathExists).mockResolvedValue(true)
    render(<PrDetailView row={row(2)} checkout="/w/r" />)
    await screen.findByText("Rename this?")
    fireEvent.click(screen.getAllByTitle("Open in editor at this line")[0]!)
    await waitFor(() => expect(ipc.openFile).toHaveBeenCalledWith("/w/r", "src/a.ts", 12))
  })

  it("no checkout of it: no editor button", async () => {
    vi.mocked(ipc.prDetail).mockResolvedValue({ ok: true, detail: detail(3) })
    render(<PrDetailView row={row(3)} />)
    await screen.findByText("Rename this?")
    expect(screen.queryByTitle("Open in editor at this line")).toBeNull()
  })

  it("an unchanged PR comes from the cache; a changed one is asked again", async () => {
    vi.mocked(ipc.prDetail).mockResolvedValue({ ok: true, detail: detail(4) })
    const first = render(<PrDetailView row={row(4)} />)
    await screen.findByText("Rename this?")
    first.unmount()
    render(<PrDetailView row={row(4)} />)
    expect(screen.getByText("Rename this?")).toBeInTheDocument() // at once
    await new Promise((r) => setTimeout(r, 300))
    expect(ipc.prDetail).toHaveBeenCalledTimes(1)
  })

  it("an answer that comes after the view moved on is still kept for coming back", async () => {
    let finish: (v: Awaited<ReturnType<typeof ipc.prDetail>>) => void = () => {}
    vi.mocked(ipc.prDetail).mockImplementationOnce(() => new Promise((r) => (finish = r)))
    const first = render(<PrDetailView row={row(6)} />)
    await waitFor(() => expect(ipc.prDetail).toHaveBeenCalled())
    first.unmount()
    finish({ ok: true, detail: detail(6) })
    await new Promise((r) => setTimeout(r, 0))
    render(<PrDetailView row={row(6)} />)
    expect(screen.getByText("Rename this?")).toBeInTheDocument()
  })

  it("a whole-file thread isn't called outdated, and opens in the editor", async () => {
    const t = { ...detail(7).threads[0]!, line: null }
    vi.mocked(ipc.prDetail).mockResolvedValue({ ok: true, detail: detail(7, { threads: [t] }) })
    render(<PrDetailView row={row(7)} checkout="/w" />)
    expect(await screen.findByText("whole file")).toBeInTheDocument()
    expect(screen.getByTitle("Open in editor at this line")).toBeInTheDocument()
  })

  it("a thread on a removed line says so, and has no editor jump (its line is the base's)", async () => {
    const t = { ...detail(9).threads[0]!, removed: true }
    vi.mocked(ipc.prDetail).mockResolvedValue({ ok: true, detail: detail(9, { threads: [t] }) })
    render(<PrDetailView row={row(9)} checkout="/w" />)
    expect(await screen.findByText("removed line 12")).toBeInTheDocument()
    expect(screen.queryByTitle("Open in editor at this line")).toBeNull()
  })

  it("logged out: says what to run", async () => {
    vi.mocked(ipc.prDetail).mockResolvedValue({ ok: false, error: "unauthenticated" })
    render(<PrDetailView row={row(8)} />)
    expect(await screen.findByText(/gh auth login/)).toBeInTheDocument()
  })

  it("a failure says so", async () => {
    vi.mocked(ipc.prDetail).mockResolvedValue({ ok: false, error: "offline" })
    render(<PrDetailView row={row(5)} />)
    expect(await screen.findByText(/Can't reach GitHub/)).toBeInTheDocument()
  })
})

describe("PrDetailView: markdown bodies", () => {
  const body =
    "## Summary\n\n- [x] done\n\nFixes #12, see #13 and [the doc](docs/x.md).\n\n<img src=x onerror=alert(1)>"
  const links = {
    closes: [
      {
        url: "https://github.com/o/r/issues/12",
        number: 12,
        repo: "o/r",
        title: "The bug",
        kind: "issue" as const,
        state: null,
      },
    ],
    mentions: [],
    mentionedBy: [],
  }

  it("renders as GitHub does, raw HTML as text", async () => {
    vi.mocked(ipc.prDetail).mockResolvedValue({ ok: true, detail: detail(20, { body, links }) })
    const { container } = render(<PrDetailView row={row(20)} />)
    await waitFor(() => expect(container.querySelector(".pr-md h2")).not.toBeNull())
    expect(container.querySelector('.pr-md input[type="checkbox"]')).not.toBeNull()
    expect(container.querySelector(".pr-md img")).toBeNull()
    expect(container.querySelector(".pr-md")!.textContent).toContain("<img src=x")
  })

  it("a reference selects a listed PR, else opens on GitHub with its title as tooltip", async () => {
    const onGo = vi.fn((pr: { number: number }) => pr.number === 13)
    vi.mocked(ipc.prDetail).mockResolvedValue({ ok: true, detail: detail(21, { body, links }) })
    const { container } = render(<PrDetailView row={row(21)} onGo={onGo} />)
    const ref = (n: number) => container.querySelector<HTMLElement>(`.pr-md a[data-ref="o/r#${n}"]`)
    await waitFor(() => expect(ref(12)).not.toBeNull())
    const twelve = ref(12)!
    expect(twelve.getAttribute("title")).toBe("The bug")
    fireEvent.click(twelve)
    expect(onGo).toHaveBeenCalledWith({ repo: "o/r", number: 12 })
    expect(ipc.openExternal).toHaveBeenCalledWith("https://github.com/o/r/issues/12")
    vi.mocked(ipc.openExternal).mockClear()
    fireEvent.click(ref(13)!) // listed: selected in the dialog, not opened
    expect(ipc.openExternal).not.toHaveBeenCalled()
    fireEvent.click(screen.getByText("the doc"))
    expect(ipc.openExternal).toHaveBeenCalledWith("https://github.com/o/r/blob/HEAD/docs/x.md")
  })
})
