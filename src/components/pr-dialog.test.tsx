import { describe, it, expect, beforeEach, vi } from "vitest"
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react"
import { PrDialog } from "./pr-dialog"
import { useStore } from "../store"
import { ipc } from "../lib/ipc"
import { resetStore, testShell } from "../test/helpers"
import type { PrLists, PrRow } from "../lib/pr-dashboard"
import type { PrDetail } from "../lib/pr-detail"
import type { PrMergeOptions } from "../lib/pr-merge"
import type { PrBranchOptions } from "../lib/pr-branch"
import { resetPrEdits } from "./pr-edits"

const st = () => useStore.getState()
const lastCall = () => {
  const calls = vi.mocked(ipc.prLists).mock.calls
  return calls[calls.length - 1]![0]
}

const row = (n: number, over: Partial<PrRow> = {}): PrRow => ({
  number: n,
  title: `PR ${n}`,
  url: `https://github.com/o/r/pull/${n}`,
  repo: "o/r",
  author: "me",
  state: "open",
  head: `b${n}`,
  fork: false,
  base: "main",
  review: null,
  reviewers: [],
  requested: [],
  merge: "clean",
  ci: null,
  comments: 0,
  additions: 1,
  deletions: 0,
  updatedAt: "",
  ...over,
})

const NO_BRANCH: PrBranchOptions = {
  canUpdateBranch: false,
  canEdit: false,
  canClose: false,
  canReopen: false,
  behind: null,
}

const answer = (lists: Partial<PrLists>) =>
  vi.mocked(ipc.prLists).mockResolvedValue({ ok: true, lists: { mine: [], review: [], ...lists } })

beforeEach(() => {
  resetStore()
  vi.clearAllMocks()
  localStorage.clear()
  resetPrEdits()
  st().newTab(testShell)
  st().setPrDialogOpen(true)
})

describe("PrDialog", () => {
  it("asks for the focused pane's checkout and lists my PRs with their status", async () => {
    const id = st().tabs[0]!.activeSessionId
    st().setPaneGit({ [id]: { root: "/w/r", branch: "b1" } }, [id])
    answer({ mine: [row(1, { review: "approved", ci: "success" }), row(2, { state: "draft" })] })
    render(<PrDialog />)
    expect(await screen.findByRole("option", { name: /PR 1/ })).toBeInTheDocument()
    expect(ipc.prLists).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: "/w/r", closed: false }),
    )
    expect(screen.getAllByText("approved").length).toBeGreaterThan(0)
    expect(screen.getByText("draft")).toBeInTheDocument()
  })

  it("tabs: the repo tab is named after the repo; keys switch and move", async () => {
    answer({ mine: [row(1)], review: [row(2)], repo: [row(3), row(4)], repoName: "o/r" })
    render(<PrDialog />)
    await screen.findByRole("option", { name: /PR 1/ })
    const dialog = screen.getByRole("dialog")
    fireEvent.keyDown(dialog, { key: "3" })
    expect(screen.getByRole("tab", { name: /o\/r/ })).toHaveAttribute("aria-selected", "true")
    expect(screen.getByRole("option", { name: /PR 3/ })).toHaveAttribute("aria-selected", "true")
    fireEvent.keyDown(dialog, { key: "j" })
    expect(screen.getByRole("option", { name: /PR 4/ })).toHaveAttribute("aria-selected", "true")
    fireEvent.keyDown(dialog, { key: "o" })
    expect(ipc.openExternal).toHaveBeenCalledWith("https://github.com/o/r/pull/4")
  })

  it("no repo tab without a GitHub repo", async () => {
    answer({ mine: [row(1)] })
    render(<PrDialog />)
    await screen.findByRole("option", { name: /PR 1/ })
    expect(screen.getAllByRole("tab")).toHaveLength(2)
  })

  it("gh missing or logged out: says what to do", async () => {
    vi.mocked(ipc.prLists).mockResolvedValue({ ok: false, error: "unauthenticated" })
    render(<PrDialog />)
    expect(await screen.findByText(/gh auth login/)).toBeInTheDocument()
  })

  it("a PR checked out in a pane links to it", async () => {
    const id = st().tabs[0]!.activeSessionId
    st().setPaneGit({ [id]: { root: "/w/r", pr: { number: 1, state: "open", url: row(1).url } } }, [
      id,
    ])
    answer({ mine: [row(1)] })
    render(<PrDialog />)
    await screen.findByRole("option", { name: /PR 1/ })
    fireEvent.click(screen.getByTitle("This terminal")) // (the focused pane: "here")
    expect(st().prDialogOpen).toBe(false)
  })

  it("a toggle while a refresh runs: asked again at once, the old answer dropped", async () => {
    let finish: (v: Awaited<ReturnType<typeof ipc.prLists>>) => void = () => {}
    vi.mocked(ipc.prLists).mockImplementationOnce(() => new Promise((r) => (finish = r)))
    answer({ mine: [row(9)] })
    render(<PrDialog />)
    fireEvent.click(screen.getByRole("checkbox"))
    await act(async () => finish({ ok: true, lists: { mine: [row(1)], review: [] } }))
    expect(await screen.findByRole("option", { name: /PR 9/ })).toBeInTheDocument()
    expect(screen.queryByRole("option", { name: /PR 1\b/ })).toBeNull()
    expect(lastCall()).toMatchObject({ closed: true })
  })

  it("Enter on a focused button is the button's, not 'open on GitHub'", async () => {
    answer({ mine: [row(1)] })
    render(<PrDialog />)
    await screen.findByRole("option", { name: /PR 1/ })
    fireEvent.keyDown(screen.getByTitle("Refresh (r)"), { key: "Enter" })
    expect(ipc.openExternal).not.toHaveBeenCalled()
    fireEvent.keyDown(screen.getByRole("checkbox"), { key: "Escape" })
    expect(st().prDialogOpen).toBe(false)
  })

  it("with a button focused, the dialog's keys still work; app shortcuts aren't taken", async () => {
    answer({ mine: [row(1), row(2)] })
    render(<PrDialog />)
    await screen.findByRole("option", { name: /PR 1/ })
    const tab = screen.getByRole("tab", { name: /Review/ })
    fireEvent.keyDown(tab, { key: "j" })
    expect(screen.getByRole("option", { name: /PR 2/ })).toHaveAttribute("aria-selected", "true")
    fireEvent.keyDown(tab, { key: "k", metaKey: true })
    expect(screen.getByRole("option", { name: /PR 2/ })).toHaveAttribute("aria-selected", "true")
  })

  it("the selection follows its PR when a refresh reorders the list", async () => {
    answer({ mine: [row(1), row(2), row(3)] })
    render(<PrDialog />)
    await screen.findByRole("option", { name: /PR 1/ })
    fireEvent.click(screen.getByRole("option", { name: /PR 3/ }))
    answer({ mine: [row(3), row(1), row(2)] })
    fireEvent.click(screen.getByTitle("Refresh (r)"))
    await waitFor(() => expect(screen.getAllByRole("option")[0]).toHaveAccessibleName(/PR 3/))
    expect(screen.getByRole("option", { name: /PR 3/ })).toHaveAttribute("aria-selected", "true")
  })

  it("reopened from another repo: the last answer isn't shown as this one's", async () => {
    const id = st().tabs[0]!.activeSessionId
    st().setPaneGit({ [id]: { root: "/w/a" } }, [id])
    answer({ mine: [], repo: [row(1)], repoName: "o/a" })
    const first = render(<PrDialog />)
    await screen.findByRole("tab", { name: /o\/a/ })
    first.unmount()
    st().setPaneGit({ [id]: { root: "/w/b" } }, [id])
    vi.mocked(ipc.prLists).mockImplementation(() => new Promise(() => {})) // still loading
    render(<PrDialog />)
    expect(screen.queryByRole("tab", { name: /o\/a/ })).toBeNull()
  })

  it("logged out: no more automatic tries", async () => {
    vi.useFakeTimers()
    try {
      vi.mocked(ipc.prLists).mockResolvedValue({ ok: false, error: "unauthenticated" })
      render(<PrDialog />)
      await act(async () => {})
      await act(async () => vi.advanceTimersByTimeAsync(10 * 60_000))
      expect(ipc.prLists).toHaveBeenCalledTimes(3) // one refresh: a request per tab
    } finally {
      vi.useRealTimers()
    }
  })

  it("threads open in the editor only from a checkout of that PR's branch, at its root", async () => {
    const id = st().tabs[0]!.activeSessionId
    const thread = {
      path: "a.ts",
      line: 3,
      resolved: false,
      outdated: false,
      removed: false,
      hunk: "",
      comments: [],
    }
    const detail = {
      url: row(1).url,
      updatedAt: "",
      body: "",
      conversation: [],
      threads: [thread],
      links: { closes: [], mentions: [], mentionedBy: [] },
      more: false,
    }
    vi.mocked(ipc.prDetail).mockResolvedValue({ ok: true, detail })
    answer({ mine: [row(1)], repo: [], repoName: "O/R" }) // the remote's spelling of o/r
    st().setPaneGit({ [id]: { root: "/w/r", branch: "main" } }, [id])
    const view = render(<PrDialog />)
    await screen.findByText("line 3")
    expect(screen.queryByTitle("Open in editor at this line")).toBeNull() // on main, not b1
    view.unmount()
    st().setPaneGit({ [id]: { root: "/w/r", branch: "b1" } }, [id])
    const again = render(<PrDialog />)
    await screen.findByText("line 3")
    expect(screen.getByTitle("Open in editor at this line")).toBeInTheDocument()
    again.unmount()
    answer({ mine: [row(1, { fork: true })], repo: [], repoName: "o/r" }) // from a fork's b1
    render(<PrDialog />)
    await screen.findByText("line 3")
    expect(screen.queryByTitle("Open in editor at this line")).toBeNull()
  })

  it("Esc closes; nothing is asked after", async () => {
    answer({ mine: [] })
    render(<PrDialog />)
    await waitFor(() => expect(ipc.prLists).toHaveBeenCalledTimes(3))
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" })
    expect(st().prDialogOpen).toBe(false)
  })

  it("refreshes every minute while open", async () => {
    vi.useFakeTimers()
    try {
      answer({ mine: [] })
      render(<PrDialog />)
      await act(async () => {})
      expect(ipc.prLists).toHaveBeenCalledTimes(3)
      await act(async () => vi.advanceTimersByTimeAsync(60_000))
      expect(ipc.prLists).toHaveBeenCalledTimes(6)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe("PrDialog reviewers", () => {
  const cand = (login: string, over = {}) => ({
    login,
    name: "",
    team: false,
    suggested: false,
    ...over,
  })

  it("the picker: suggestions first, a click requests, the PR's fresh row shows it", async () => {
    const pr = row(41, { updatedAt: "2026-10-14T09:00:00Z" })
    answer({ mine: [pr] })
    vi.mocked(ipc.prCandidates).mockResolvedValue({
      ok: true,
      candidates: {
        suggested: [cand("ann", { suggested: true })],
        people: [cand("me"), cand("bob", { name: "Bob B" })],
        teams: "no-scope",
      },
    })
    const fresh = { ...pr, requested: ["bob"], updatedAt: "2026-10-14T10:00:00Z" }
    vi.mocked(ipc.prReviewers).mockResolvedValue({ ok: true, row: fresh })
    render(<PrDialog />)
    fireEvent.click(await screen.findByRole("button", { name: /Request reviewer/ }))
    const picker = await screen.findByRole("listbox", { name: "Reviewers" })
    await waitFor(() => expect(picker.querySelectorAll("[role=option]")).toHaveLength(2))
    expect(picker.textContent).toMatch(/ann.*suggested.*bob.*Bob B/)
    expect(screen.getByText("gh auth refresh -s read:org")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("option", { name: /bob/ }))
    await waitFor(() =>
      expect(ipc.prReviewers).toHaveBeenCalledWith(
        expect.objectContaining({ repo: "o/r", number: 41, add: ["bob"], remove: [] }),
      ),
    )
    expect(await screen.findByTitle("Remove the review request for bob")).toBeInTheDocument()
    expect(screen.getByRole("option", { name: /bob/ })).toHaveAttribute("aria-disabled", "true")
  })

  it("typing searches (the dialog's keys stay out of it); Esc closes the picker only", async () => {
    answer({ mine: [row(42), row(43)] })
    vi.mocked(ipc.prCandidates).mockResolvedValue({
      ok: true,
      candidates: { suggested: [], people: [], teams: null },
    })
    render(<PrDialog />)
    await screen.findByRole("option", { name: /PR 42/ }) // not the last test's answer
    fireEvent.click(await screen.findByRole("button", { name: /Request reviewer/ }))
    const input = screen.getByRole("textbox", { name: "Search reviewers" })
    fireEvent.keyDown(input, { key: "j" })
    fireEvent.change(input, { target: { value: "jo" } })
    expect(screen.getByRole("option", { name: /PR 42/ })).toHaveAttribute("aria-selected", "true")
    await waitFor(() =>
      expect(ipc.prCandidates).toHaveBeenLastCalledWith(expect.objectContaining({ query: "jo" })),
    )
    fireEvent.keyDown(input, { key: "Escape" })
    expect(screen.queryByRole("textbox", { name: "Search reviewers" })).toBeNull()
    expect(st().prDialogOpen).toBe(true)
  })

  it("a pending request is removed by its ✕; gh's refusal is shown", async () => {
    answer({ mine: [row(44, { requested: ["bob"] })] })
    vi.mocked(ipc.prReviewers).mockResolvedValue({
      ok: false,
      error: "failed",
      message: "not allowed",
    })
    render(<PrDialog />)
    fireEvent.click(await screen.findByTitle("Remove the review request for bob"))
    expect(await screen.findByText(/not allowed/)).toBeInTheDocument()
    expect(ipc.prReviewers).toHaveBeenCalledWith(
      expect.objectContaining({ number: 44, add: [], remove: ["bob"] }),
    )
  })

  it("the change went through but the PR couldn't be asked for again: shown anyway", async () => {
    answer({ mine: [row(46, { updatedAt: "2026-10-14T09:00:00Z" })] })
    vi.mocked(ipc.prCandidates).mockResolvedValue({
      ok: true,
      candidates: { suggested: [], people: [cand("bob")], teams: null },
    })
    vi.mocked(ipc.prReviewers).mockResolvedValue({ ok: true, row: null })
    render(<PrDialog />)
    await screen.findByRole("option", { name: /PR 46/ })
    fireEvent.click(screen.getByRole("button", { name: /Request reviewer/ }))
    fireEvent.click(await screen.findByRole("option", { name: /bob/ }))
    expect(await screen.findByTitle("Remove the review request for bob")).toBeInTheDocument()
  })

  it("an edit answered after moving to another PR still shows, over older list copies", async () => {
    let answerEdit: (r: Awaited<ReturnType<typeof ipc.prReviewers>>) => void = () => {}
    const pr = row(47, { updatedAt: "2026-10-14T09:00:00Z", ci: "pending" })
    answer({ mine: [pr, row(48)] })
    vi.mocked(ipc.prCandidates).mockResolvedValue({
      ok: true,
      candidates: { suggested: [], people: [cand("bob")], teams: null },
    })
    vi.mocked(ipc.prReviewers).mockReturnValue(new Promise((r) => (answerEdit = r)))
    render(<PrDialog />)
    await screen.findByRole("option", { name: /PR 47/ })
    fireEvent.click(screen.getByRole("button", { name: /Request reviewer/ }))
    fireEvent.click(await screen.findByRole("option", { name: /bob/ }))
    fireEvent.click(screen.getByRole("option", { name: /PR 48/ }))
    const fresh = { ...pr, requested: ["bob"], updatedAt: "2026-10-14T10:00:00Z" }
    await act(async () => answerEdit({ ok: true, row: fresh }))
    fireEvent.click(screen.getByRole("option", { name: /PR 47/ }))
    expect(await screen.findByTitle("Remove the review request for bob")).toBeInTheDocument()
    // a lagging list copy (older) keeps the change; one as new (CI moved on) is the list's
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "r" })
    await waitFor(() => expect(ipc.prLists).toHaveBeenCalledTimes(6))
    expect(await screen.findByTitle("Remove the review request for bob")).toBeInTheDocument()
    answer({ mine: [{ ...fresh, ci: "success" }, row(48)] })
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "r" })
    expect((await screen.findAllByText("CI passed")).length).toBeGreaterThan(0)
    answer({ mine: [{ ...fresh, requested: [], updatedAt: "2026-10-14T11:00:00Z" }, row(48)] })
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "r" })
    await waitFor(() => expect(screen.queryByTitle("Remove the review request for bob")).toBeNull())
  })

  it("a reviewer asked again after reviewing can be un-asked", async () => {
    answer({
      mine: [row(49, { reviewers: [{ login: "bob", state: "approved" }], requested: ["bob"] })],
    })
    render(<PrDialog />)
    await screen.findByRole("option", { name: /PR 49/ })
    expect(screen.getByTitle("Remove the review request for bob")).toBeInTheDocument()
  })

  it("closing the picker gives the keys back to the dialog", async () => {
    answer({ mine: [row(50), row(51)] })
    vi.mocked(ipc.prCandidates).mockResolvedValue({
      ok: true,
      candidates: { suggested: [], people: [], teams: null },
    })
    render(<PrDialog />)
    await screen.findByRole("option", { name: /PR 50/ })
    fireEvent.click(screen.getByRole("button", { name: /Request reviewer/ }))
    const input = screen.getByRole("textbox", { name: "Search reviewers" })
    input.focus()
    fireEvent.keyDown(input, { key: "Escape" })
    expect(document.activeElement).toBe(screen.getByRole("dialog"))
    fireEvent.keyDown(document.activeElement!, { key: "Escape" })
    expect(st().prDialogOpen).toBe(false)
  })

  it("a double click sends one change", async () => {
    answer({ mine: [row(52)] })
    vi.mocked(ipc.prCandidates).mockResolvedValue({
      ok: true,
      candidates: { suggested: [], people: [cand("bob")], teams: null },
    })
    vi.mocked(ipc.prReviewers).mockReturnValue(new Promise(() => {}))
    render(<PrDialog />)
    await screen.findByRole("option", { name: /PR 52/ })
    fireEvent.click(screen.getByRole("button", { name: /Request reviewer/ }))
    const bob = await screen.findByRole("option", { name: /bob/ })
    fireEvent.click(bob)
    fireEvent.click(bob)
    expect(ipc.prReviewers).toHaveBeenCalledTimes(1)
  })

  it("a click on someone keeps the focus in the search box", async () => {
    answer({ mine: [row(53)] })
    vi.mocked(ipc.prCandidates).mockResolvedValue({
      ok: true,
      candidates: { suggested: [], people: [cand("bob")], teams: null },
    })
    render(<PrDialog />)
    await screen.findByRole("option", { name: /PR 53/ })
    fireEvent.click(screen.getByRole("button", { name: /Request reviewer/ }))
    const bob = await screen.findByRole("option", { name: /bob/ })
    expect(fireEvent.mouseDown(bob)).toBe(false) // default (moving the focus) prevented
  })

  it("an edit's failure still shows after moving away and back", async () => {
    let fail: (r: Awaited<ReturnType<typeof ipc.prReviewers>>) => void = () => {}
    answer({ mine: [row(54, { requested: ["bob"] }), row(55)] })
    vi.mocked(ipc.prReviewers).mockReturnValue(new Promise((r) => (fail = r)))
    render(<PrDialog />)
    await screen.findByRole("option", { name: /PR 54/ })
    fireEvent.click(screen.getByTitle("Remove the review request for bob"))
    fireEvent.click(screen.getByRole("option", { name: /PR 55/ }))
    fireEvent.click(screen.getByRole("option", { name: /PR 54/ }))
    expect(screen.getByTitle("Remove the review request for bob")).toBeDisabled() // still running
    await act(async () => fail({ ok: false, error: "failed", message: "not allowed" }))
    fireEvent.click(screen.getByRole("option", { name: /PR 55/ }))
    fireEvent.click(screen.getByRole("option", { name: /PR 54/ }))
    expect(screen.getByText(/not allowed/)).toBeInTheDocument()
  })

  it("an edit that lands after the dialog was closed and reopened shows there", async () => {
    let done: (r: Awaited<ReturnType<typeof ipc.prReviewers>>) => void = () => {}
    const pr = row(56, { requested: ["bob"], updatedAt: "2026-10-14T09:00:00Z" })
    answer({ mine: [pr] })
    vi.mocked(ipc.prReviewers).mockReturnValue(new Promise((r) => (done = r)))
    const first = render(<PrDialog />)
    await screen.findByRole("option", { name: /PR 56/ })
    fireEvent.click(screen.getByTitle("Remove the review request for bob"))
    first.unmount()
    render(<PrDialog />)
    await screen.findByRole("option", { name: /PR 56/ })
    const fresh = { ...pr, requested: [], updatedAt: "2026-10-14T10:00:00Z" }
    await act(async () => done({ ok: true, row: fresh }))
    expect(screen.queryByTitle("Remove the review request for bob")).toBeNull()
  })

  it("merged or closed: no requests", async () => {
    answer({ mine: [row(45, { state: "merged", requested: ["bob"] })] })
    render(<PrDialog />)
    await screen.findByRole("option", { name: /PR 45/ })
    expect(screen.queryByRole("button", { name: /Request reviewer/ })).toBeNull()
    expect(screen.queryByTitle(/Remove the review request/)).toBeNull()
  })
})

describe("PrDialog stacks and links", () => {
  const det = (n: number, links: Partial<PrDetail["links"]>): PrDetail => ({
    url: row(n).url,
    updatedAt: "",
    body: "",
    conversation: [],
    threads: [],
    links: { closes: [], mentions: [], mentionedBy: [], ...links },
    more: false,
  })

  it("a stack is listed under its bottom PR; j/k follow that order", async () => {
    answer({
      mine: [row(62, { head: "c", base: "b" }), row(63), row(61, { head: "b", base: "a" })],
      review: [row(60, { head: "a", base: "main" })],
    })
    render(<PrDialog />)
    await screen.findByRole("option", { name: /PR 62/ })
    expect(screen.getAllByRole("option").map((o) => o.textContent?.match(/#(\d+)/)?.[1])).toEqual([
      "63",
      "61",
      "62",
    ])
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "j" })
    expect(screen.getByRole("option", { name: /PR 61/ })).toHaveAttribute("aria-selected", "true")
    // its base PR is in another tab: "on #60" goes there
    expect(document.querySelector(".pr-stack-line")?.textContent).toBe(
      "Stacked on #60 · Stacked on this: #62",
    )
    fireEvent.click(screen.getByRole("button", { name: "on #60" }))
    expect(screen.getByRole("tab", { name: /Review requested/ })).toHaveAttribute(
      "aria-selected",
      "true",
    )
    expect(screen.getByRole("option", { name: /PR 60/ })).toHaveAttribute("aria-selected", "true")
    expect(localStorage.getItem("minmux.prDialog.tab")).toBeNull() // a jump isn't a choice
  })

  it("links: a listed PR is selected here, anything else opens on GitHub", async () => {
    answer({ mine: [row(70), row(71)] })
    const link = (n: number, kind: "pr" | "issue") => ({
      url: `https://github.com/o/r/${kind === "pr" ? "pull" : "issues"}/${n}`,
      number: n,
      repo: "o/r",
      title: `Linked ${n}`,
      kind,
      state: "open" as const,
    })
    vi.mocked(ipc.prDetail).mockResolvedValue({
      ok: true,
      detail: det(70, {
        closes: [link(5, "issue")],
        mentions: [
          { ...link(71, "pr"), title: "", kind: null },
          { ...link(5, "pr"), title: "", kind: null }, // the body's #5, an issue really
        ],
        mentionedBy: [link(99, "pr")],
      }),
    })
    render(<PrDialog />)
    await screen.findByText("Links")
    expect(screen.getByText("PR 71", { selector: ".pr-links span" })).toBeInTheDocument() // titled from the list
    fireEvent.click(screen.getByRole("button", { name: "#99" }))
    expect(ipc.openExternal).toHaveBeenCalledWith("https://github.com/o/r/pull/99")
    // a bare #5 in the body the timeline knows: an issue, opened as one
    fireEvent.click(screen.getAllByRole("button", { name: "#5" })[0]!)
    expect(ipc.openExternal).toHaveBeenLastCalledWith("https://github.com/o/r/issues/5")
    fireEvent.click(screen.getByRole("button", { name: "#71" }))
    expect(screen.getByRole("option", { name: /PR 71/ })).toHaveAttribute("aria-selected", "true")
  })
})

describe("PrDialog accounts", () => {
  const two = [
    { login: "me", active: true, ok: true },
    { login: "work", active: false, ok: true },
  ]

  it("one gh account: says who it runs as", async () => {
    answer({ mine: [row(80)], accounts: [{ login: "me", active: true, ok: true }] })
    render(<PrDialog />)
    expect(await screen.findByText("as @me")).toBeInTheDocument()
    expect(screen.queryByRole("combobox", { name: "GitHub account" })).toBeNull()
  })

  it("several: all by default, each PR tagged; the repo tab names its account", async () => {
    answer({
      mine: [row(81, { account: "me" }), row(82, { account: "work" })],
      repo: [row(82, { account: "work" })],
      repoName: "o/r",
      repoAccount: "work",
      repoVisible: true,
      accounts: two,
    })
    render(<PrDialog />)
    await screen.findByRole("option", { name: /PR 81/ })
    expect(screen.getByRole("combobox", { name: "GitHub account" })).toHaveValue("")
    expect(screen.getByRole("option", { name: /PR 82/ }).textContent).toContain("@work")
    expect(screen.getByRole("tab", { name: /o\/r · @work/ })).toBeInTheDocument()
    expect(lastCall().account).toBeUndefined()
  })

  it("picking an account asks for its lists, and is kept for the next open", async () => {
    answer({ mine: [row(83, { account: "work" })], accounts: two })
    render(<PrDialog />)
    await screen.findByRole("option", { name: /PR 83/ })
    fireEvent.change(screen.getByRole("combobox", { name: "GitHub account" }), {
      target: { value: "work" },
    })
    await waitFor(() => expect(lastCall().account).toBe("work"))
    expect(localStorage.getItem("minmux.prDialog.account")).toBe("work")
    expect(document.activeElement).toBe(screen.getByRole("dialog")) // j/k work again
  })

  it("a repo the account can't see says so", async () => {
    localStorage.setItem("minmux.prDialog.account", "me")
    answer({ mine: [], repo: [], repoName: "o/r", repoVisible: false, accounts: two })
    render(<PrDialog />)
    await waitFor(() => expect(ipc.prLists).toHaveBeenCalled())
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "3" })
    expect(await screen.findByText(/@me can't see o\/r/)).toBeInTheDocument()
  })

  it("a failing account keeps the picker, to pick another", async () => {
    vi.mocked(ipc.prLists).mockResolvedValue({
      ok: false,
      error: "failed",
      message: "SAML",
      accounts: two,
    })
    render(<PrDialog />)
    expect(await screen.findByText(/SAML/)).toBeInTheDocument()
    expect(screen.getByRole("combobox", { name: "GitHub account" })).toBeInTheDocument()
  })

  it("a saved account that's gone or signed out: every account's lists, the pick kept", async () => {
    localStorage.setItem("minmux.prDialog.account", "old")
    answer({ mine: [row(85, { account: "me" })], accounts: two })
    render(<PrDialog />)
    // shown as every account's (main lists them all), the pick kept for another pane's gh
    expect((await screen.findByRole("option", { name: /PR 85/ })).textContent).toContain("@me")
    expect(screen.getByRole("combobox", { name: "GitHub account" })).toHaveValue("")
    expect(localStorage.getItem("minmux.prDialog.account")).toBe("old")
  })

  it("a PR's requests go out as the account that listed it", async () => {
    answer({ mine: [row(84, { account: "work", requested: ["bob"] })], accounts: two })
    vi.mocked(ipc.prReviewers).mockResolvedValue({ ok: true, row: null })
    render(<PrDialog />)
    await screen.findByRole("option", { name: /PR 84/ })
    expect(screen.getByText("as @work")).toBeInTheDocument()
    fireEvent.click(screen.getByTitle("Remove the review request for bob"))
    await waitFor(() =>
      expect(ipc.prReviewers).toHaveBeenCalledWith(expect.objectContaining({ account: "work" })),
    )
    await waitFor(() =>
      // (asked for after a pause)
      expect(ipc.prDetail).toHaveBeenCalledWith(expect.objectContaining({ account: "work" })),
    )
  })
})

describe("PrDialog comment and review", () => {
  const det = (n: number): PrDetail => ({
    url: row(n).url,
    updatedAt: "",
    body: "",
    conversation: [],
    threads: [],
    links: { closes: [], mentions: [], mentionedBy: [] },
    more: false,
  })

  it("comments with ⌘Enter as the PR's account, then shows the conversation again", async () => {
    answer({ mine: [row(90, { author: "ann", account: "work" })] })
    vi.mocked(ipc.prDetail).mockResolvedValue({ ok: true, detail: det(90) })
    vi.mocked(ipc.prWrite).mockResolvedValue({ ok: true, row: null })
    render(<PrDialog />)
    await screen.findByRole("option", { name: /PR 90/ })
    const box = await screen.findByRole("textbox", { name: "Comment" })
    const asked = vi.mocked(ipc.prDetail).mock.calls.length
    fireEvent.change(box, { target: { value: "Looks good\nto me" } })
    fireEvent.keyDown(box, { key: "j" }) // typing: not the dialog's keys
    fireEvent.keyDown(box, { key: "Enter", metaKey: true })
    await waitFor(() =>
      expect(ipc.prWrite).toHaveBeenCalledWith(
        expect.objectContaining({
          number: 90,
          action: "comment",
          body: "Looks good\nto me",
          account: "work",
        }),
      ),
    )
    expect(await screen.findByText("Commented.")).toBeInTheDocument()
    expect(box).toHaveValue("")
    await waitFor(() => expect(vi.mocked(ipc.prDetail).mock.calls.length).toBeGreaterThan(asked))
  })

  it("approve on others' open PRs only; request changes needs a comment", async () => {
    answer({
      mine: [row(91, { author: "ann", account: "me" }), row(92, { author: "me", account: "me" })],
    })
    vi.mocked(ipc.prDetail).mockImplementation(async (r) => ({ ok: true, detail: det(r.number) }))
    vi.mocked(ipc.prWrite).mockResolvedValue({ ok: true, row: null })
    render(<PrDialog />)
    await screen.findByRole("option", { name: /PR 91/ })
    await screen.findByRole("textbox", { name: "Comment" })
    expect(screen.getByRole("button", { name: /Request changes/ })).toBeDisabled()
    fireEvent.click(screen.getByRole("button", { name: /Approve/ }))
    await waitFor(() =>
      expect(ipc.prWrite).toHaveBeenCalledWith(
        expect.objectContaining({ number: 91, action: "approve", body: "" }),
      ),
    )
    fireEvent.click(screen.getByRole("option", { name: /PR 92/ }))
    await screen.findByRole("textbox", { name: "Comment" })
    expect(screen.queryByRole("button", { name: /Approve/ })).toBeNull() // your own PR
  })

  it("an unsent comment is kept when moving away and back; gh's refusal is shown", async () => {
    answer({ mine: [row(93, { author: "ann" }), row(94, { author: "ann" })] })
    vi.mocked(ipc.prDetail).mockImplementation(async (r) => ({ ok: true, detail: det(r.number) }))
    vi.mocked(ipc.prWrite).mockResolvedValue({
      ok: false,
      error: "failed",
      message: "Resource not accessible",
    })
    render(<PrDialog />)
    await screen.findByRole("option", { name: /PR 93/ })
    fireEvent.change(await screen.findByRole("textbox", { name: "Comment" }), {
      target: { value: "draft" },
    })
    fireEvent.click(screen.getByRole("option", { name: /PR 94/ }))
    await screen.findByRole("textbox", { name: "Comment" })
    fireEvent.click(screen.getByRole("option", { name: /PR 93/ }))
    const box = await screen.findByRole("textbox", { name: "Comment" })
    expect(box).toHaveValue("draft")
    fireEvent.click(screen.getByRole("button", { name: /^Comment$/ }))
    expect(await screen.findByText(/Resource not accessible/)).toBeInTheDocument()
    expect(box).toHaveValue("draft") // not lost
  })
})

describe("PrDialog comment and review, safety", () => {
  const det = (n: number): PrDetail => ({
    url: row(n).url,
    updatedAt: "",
    body: "",
    conversation: [],
    threads: [],
    links: { closes: [], mentions: [], mentionedBy: [] },
    more: false,
  })

  it("moving away and back mid-send: still sending, never a second send", async () => {
    let finish: (r: Awaited<ReturnType<typeof ipc.prWrite>>) => void = () => {}
    answer({ mine: [row(95, { author: "ann" }), row(96, { author: "ann" })] })
    vi.mocked(ipc.prDetail).mockImplementation(async (r) => ({ ok: true, detail: det(r.number) }))
    vi.mocked(ipc.prWrite).mockReturnValue(new Promise((r) => (finish = r)))
    render(<PrDialog />)
    await screen.findByRole("option", { name: /PR 95/ })
    fireEvent.change(await screen.findByRole("textbox", { name: "Comment" }), {
      target: { value: "LGTM" },
    })
    fireEvent.click(screen.getByRole("button", { name: /^Comment$/ }))
    fireEvent.click(screen.getByRole("option", { name: /PR 96/ }))
    await screen.findByRole("textbox", { name: "Comment" })
    fireEvent.click(screen.getByRole("option", { name: /PR 95/ }))
    await screen.findByText("Commenting…")
    expect(screen.getByRole("button", { name: /^Comment$/ })).toBeDisabled()
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Comment" }), {
      key: "Enter",
      metaKey: true,
    })
    expect(ipc.prWrite).toHaveBeenCalledTimes(1)
    await act(async () => finish({ ok: false, error: "failed", message: "Not allowed" }))
    expect(await screen.findByText(/Not allowed/)).toBeInTheDocument()
  })

  it("a send that goes through after moving away and back: the box empties, the talk reloads", async () => {
    let finish: (r: Awaited<ReturnType<typeof ipc.prWrite>>) => void = () => {}
    answer({ mine: [row(100, { author: "ann" }), row(101, { author: "ann" })] })
    vi.mocked(ipc.prDetail).mockImplementation(async (r) => ({ ok: true, detail: det(r.number) }))
    vi.mocked(ipc.prWrite).mockReturnValue(new Promise((r) => (finish = r)))
    render(<PrDialog />)
    await screen.findByRole("option", { name: /PR 100/ })
    fireEvent.change(await screen.findByRole("textbox", { name: "Comment" }), {
      target: { value: "LGTM" },
    })
    fireEvent.click(screen.getByRole("button", { name: /^Comment$/ }))
    fireEvent.click(screen.getByRole("option", { name: /PR 101/ }))
    await screen.findByRole("textbox", { name: "Comment" })
    fireEvent.click(screen.getByRole("option", { name: /PR 100/ }))
    const box = await screen.findByRole("textbox", { name: "Comment" })
    expect(box).toHaveValue("LGTM") // (still sending: read-only)
    const asked = vi.mocked(ipc.prDetail).mock.calls.filter(([r]) => r.number === 100).length
    await act(async () => finish({ ok: true, row: null }))
    expect(await screen.findByText("Commented.")).toBeInTheDocument()
    expect(screen.getByRole("textbox", { name: "Comment" })).toHaveValue("") // never sent twice
    await waitFor(() =>
      expect(
        vi.mocked(ipc.prDetail).mock.calls.filter(([r]) => r.number === 100).length,
      ).toBeGreaterThan(asked),
    )
  })

  it("a failure while away shows on return; the box keeps the focus after sending", async () => {
    let finish: (r: Awaited<ReturnType<typeof ipc.prWrite>>) => void = () => {}
    answer({ mine: [row(97, { author: "ann" }), row(98, { author: "ann" })] })
    vi.mocked(ipc.prDetail).mockImplementation(async (r) => ({ ok: true, detail: det(r.number) }))
    vi.mocked(ipc.prWrite).mockReturnValue(new Promise((r) => (finish = r)))
    render(<PrDialog />)
    await screen.findByRole("option", { name: /PR 97/ })
    fireEvent.click(await screen.findByRole("button", { name: /Approve/ }))
    fireEvent.click(screen.getByRole("option", { name: /PR 98/ }))
    await act(async () => finish({ ok: false, error: "failed", message: "Review refused" }))
    fireEvent.click(screen.getByRole("option", { name: /PR 97/ }))
    expect(await screen.findByText(/Review refused/)).toBeInTheDocument()
    vi.mocked(ipc.prWrite).mockResolvedValue({ ok: true, row: null })
    const box = screen.getByRole("textbox", { name: "Comment" })
    box.focus()
    fireEvent.change(box, { target: { value: "again" } })
    fireEvent.keyDown(box, { key: "Enter", metaKey: true })
    expect(await screen.findByText("Commented.")).toBeInTheDocument()
    expect(document.activeElement).toBe(box)
  })

  it("a draft belongs to the account it was written as; who it goes out as is in sight", async () => {
    answer({ mine: [row(99, { author: "ann", account: "work" })] })
    vi.mocked(ipc.prDetail).mockImplementation(async (r) => ({ ok: true, detail: det(r.number) }))
    const view = render(<PrDialog />)
    await screen.findByRole("option", { name: /PR 99/ })
    fireEvent.change(await screen.findByRole("textbox", { name: "Comment" }), {
      target: { value: "as work" },
    })
    const actions = () => document.querySelector(".pr-reply-actions")?.textContent ?? ""
    expect(actions()).toContain("as @work")
    view.unmount()
    answer({ mine: [row(99, { author: "ann", account: "me" })] })
    render(<PrDialog />)
    await waitFor(() => {
      expect(actions()).toContain("as @me")
      expect(screen.getByRole("textbox", { name: "Comment" })).toHaveValue("") // never as @me
    })
  })
})

describe("PrDialog loading a tab at a time", () => {
  it("a tab shows as soon as it answers; a slow one says it's loading", async () => {
    vi.mocked(ipc.prLists).mockImplementation(async (r) =>
      r.part === "mine"
        ? new Promise(() => {}) // a slow search
        : { ok: true, lists: { mine: [], review: [row(110)], repo: [], repoName: "o/r" } },
    )
    localStorage.setItem("minmux.prDialog.tab", "review")
    const id = st().tabs[0]!.activeSessionId
    st().setPaneGit({ [id]: { root: "/w/never-asked-before" } }, [id]) // nothing cached for it
    render(<PrDialog />)
    expect(await screen.findByRole("option", { name: /PR 110/ })).toBeInTheDocument()
    fireEvent.click(screen.getByRole("tab", { name: /Mine/ }))
    expect(screen.getByText("Loading…")).toBeInTheDocument()
    expect(ipc.prLists).toHaveBeenCalledWith(expect.objectContaining({ part: "mine" }))
  })

  it("listed while gh's accounts were looked up: asked again once they're known", async () => {
    vi.mocked(ipc.prLists).mockResolvedValueOnce({
      ok: true,
      lists: { mine: [row(111)], review: [], accountsPending: true },
    })
    answer({ mine: [row(111, { account: "me" })] })
    vi.mocked(ipc.prAccounts).mockResolvedValue([
      { login: "me", active: true, ok: true },
      { login: "work", active: false, ok: true },
    ])
    render(<PrDialog />)
    await waitFor(() => expect(ipc.prAccounts).toHaveBeenCalled())
    await waitFor(() => expect(ipc.prLists).toHaveBeenCalledTimes(6)) // the second round
  })

  it("gh's active account the only one: no second round; its rows tagged and kept", async () => {
    const id = st().tabs[0]!.activeSessionId
    st().setPaneGit({ [id]: { root: "/w/one-account" } }, [id])
    vi.mocked(ipc.prLists).mockResolvedValue({
      ok: true,
      lists: { mine: [row(150)], review: [], accountsPending: true },
    })
    vi.mocked(ipc.prAccounts).mockResolvedValue([{ login: "me", active: true, ok: true }])
    render(<PrDialog />)
    await screen.findByRole("option", { name: /PR 150/ })
    await waitFor(() =>
      expect(localStorage.getItem("minmux.prDialog.last") ?? "").toContain('"account":"me"'),
    )
    expect(ipc.prLists).toHaveBeenCalledTimes(3) // one round
  })

  it("the answer is kept for the next launch", async () => {
    answer({ mine: [row(112)] })
    render(<PrDialog />)
    await screen.findByRole("option", { name: /PR 112/ })
    await waitFor(() =>
      expect(localStorage.getItem("minmux.prDialog.last") ?? "").toContain("pull/112"),
    )
  })
})

describe("PrDialog requests switching", () => {
  it("back to a request: its own answer, never another one's merged parts", async () => {
    const id = st().tabs[0]!.activeSessionId
    st().setPaneGit({ [id]: { root: "/w/aaa" } }, [id])
    answer({ mine: [row(120)], repo: [row(121)], repoName: "o/a" })
    render(<PrDialog />)
    await screen.findByRole("option", { name: /PR 120/ })
    await waitFor(() =>
      expect(localStorage.getItem("minmux.prDialog.last") ?? "").toContain("pull/120"),
    )
    // pane B: its parts arrive slowly, one partial; back to A before it's done
    vi.mocked(ipc.prLists).mockImplementation(async (r) =>
      r.part === "mine"
        ? { ok: true, lists: { mine: [row(130)], review: [] } }
        : new Promise(() => {}),
    )
    act(() => st().setPaneGit({ [id]: { root: "/w/bbb" } }, [id]))
    await screen.findByRole("option", { name: /PR 130/ })
    act(() => st().setPaneGit({ [id]: { root: "/w/aaa" } }, [id]))
    expect(await screen.findByRole("option", { name: /PR 120/ })).toBeInTheDocument()
    expect(screen.queryByRole("option", { name: /PR 130/ })).toBeNull()
  })

  it("rows listed before gh's accounts were known aren't kept for the next launch", async () => {
    const id = st().tabs[0]!.activeSessionId
    st().setPaneGit({ [id]: { root: "/w/pending-only" } }, [id])
    localStorage.removeItem("minmux.prDialog.last")
    vi.mocked(ipc.prLists).mockResolvedValue({
      ok: true,
      lists: { mine: [row(140)], review: [], accountsPending: true },
    })
    vi.mocked(ipc.prAccounts).mockResolvedValue([])
    render(<PrDialog />)
    await screen.findByRole("option", { name: /PR 140/ })
    await new Promise((r) => setTimeout(r, 50))
    expect(localStorage.getItem("minmux.prDialog.last") ?? "").not.toContain("pull/140")
  })
})

describe("PrDialog working on it", () => {
  it("a PR an agent works on: its icon and status; the focused pane's PR is 'here', selected", async () => {
    const id = st().tabs[0]!.activeSessionId
    st().setPaneGit(
      { [id]: { root: "/w/here", pr: { number: 161, state: "open", url: row(161).url } } },
      [id],
    )
    st().applyAgentEvents([
      { agent: "claude", event: "SessionStart", sessionId: "s1", paneId: id },
      { agent: "claude", event: "UserPromptSubmit", sessionId: "s1", paneId: id },
    ])
    answer({ mine: [row(160), row(161)] })
    render(<PrDialog />)
    const here = await screen.findByRole("option", { name: /PR 161/ })
    await waitFor(() => expect(here).toHaveAttribute("aria-selected", "true")) // picked on open
    const chip = here.querySelector(".pr-chip.pane.here")!
    expect(chip.textContent).toContain("here")
    expect(chip.getAttribute("title")).toMatch(/Claude working in/)
    expect(screen.getByText("Working on it")).toBeInTheDocument()
  })
})

describe("PrDialog checks and commits", () => {
  const checks = (state: "running" | "passed", merge: PrMergeOptions | null = null) => ({
    ok: true as const,
    checks: {
      updatedAt: "",
      state,
      checks: [
        { name: "build", workflow: "CI", state, url: "https://ci/build" },
        { name: "lint", workflow: "CI", state: "passed" as const, url: "https://ci/lint" },
      ],
      commits: [
        { oid: "abc1234", headline: "fix: x", author: "q", at: "", url: "https://c/abc", state },
      ],
      moreCommits: 0,
      merge,
      branch: NO_BRANCH,
    },
  })

  it("the latest commit's checks and the commits; a check's log, the PR on GitHub", async () => {
    const id = st().tabs[0]!.activeSessionId
    st().setPaneGit({ [id]: { root: "/w/checks-a" } }, [id])
    answer({ mine: [row(170)] })
    vi.mocked(ipc.prChecks).mockResolvedValue(checks("passed"))
    render(<PrDialog />)
    await screen.findByRole("option", { name: /PR 170/ })
    expect(await screen.findByText("build")).toBeInTheDocument()
    expect(screen.getByText("fix: x")).toBeInTheDocument()
    fireEvent.click(screen.getAllByTitle("Open its log")[0]!)
    expect(ipc.openExternal).toHaveBeenLastCalledWith("https://ci/build")
    fireEvent.click(screen.getAllByRole("button", { name: "Open on GitHub" })[0]!) // by the title
    expect(ipc.openExternal).toHaveBeenLastCalledWith(row(170).url)
  })

  const HEAD = "a".repeat(40)
  const opts = (over: Partial<PrMergeOptions> = {}): PrMergeOptions => ({
    methods: ["merge", "squash", "rebase"],
    preferred: "merge",
    canMerge: true,
    head: HEAD,
    ...over,
  })

  it("merge: the repo's ways, a confirm step, then merged in the list at once", async () => {
    const id = st().tabs[0]!.activeSessionId
    st().setPaneGit({ [id]: { root: "/w/merge-a" } }, [id])
    answer({ mine: [row(180, { account: "me" })] })
    vi.mocked(ipc.prChecks).mockResolvedValue(checks("passed", opts()))
    vi.mocked(ipc.prMerge).mockResolvedValue({
      ok: true,
      row: row(180, { state: "merged", account: "me", updatedAt: "2026-10-15T00:00:00Z" }),
    })
    render(<PrDialog />)
    const how = await screen.findByRole("combobox", { name: "How to merge" })
    expect([...how.querySelectorAll("option")].map((o) => o.textContent)).toEqual([
      "Create a merge commit",
      "Squash and merge",
      "Rebase and merge",
    ])
    expect(how).toHaveValue("merge") // GitHub's preferred
    fireEvent.change(how, { target: { value: "squash" } })
    fireEvent.click(screen.getByRole("button", { name: /^Merge$/ }))
    expect(ipc.prMerge).not.toHaveBeenCalled() // asks first
    expect(screen.getByText(/Squash and merge #180 into/)).toBeInTheDocument()
    const lists = vi.mocked(ipc.prLists).mock.calls.length
    fireEvent.click(screen.getByRole("button", { name: /Confirm merge/ }))
    await waitFor(() =>
      expect(ipc.prMerge).toHaveBeenCalledWith(
        expect.objectContaining({
          repo: "o/r",
          number: 180,
          method: "squash",
          head: HEAD,
          account: "me",
        }),
      ),
    )
    expect(await screen.findByText(/Merged: squash and merge/)).toBeInTheDocument()
    expect(screen.getByRole("option", { name: /PR 180/ }).textContent).toContain("merged")
    await waitFor(() => expect(vi.mocked(ipc.prLists).mock.calls.length).toBeGreaterThan(lists))
    expect(JSON.parse(localStorage.getItem("minmux.prDialog.mergeMethod")!)).toEqual({
      "o/r": "squash",
    }) // picked again next time
  })

  it("merge: Cancel and Esc back out; a refusal shows gh's words; a draft can't", async () => {
    const id = st().tabs[0]!.activeSessionId
    st().setPaneGit({ [id]: { root: "/w/merge-b" } }, [id])
    answer({ mine: [row(181), row(182, { state: "draft" })] })
    vi.mocked(ipc.prChecks).mockResolvedValue(checks("passed", opts({ methods: ["squash"] })))
    vi.mocked(ipc.prMerge).mockResolvedValue({
      ok: false,
      error: "failed",
      message: "Pull request is not mergeable: the base branch policy prohibits the merge",
    })
    render(<PrDialog />)
    const merge = await screen.findByRole("button", { name: /^Merge$/ })
    fireEvent.click(merge)
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }))
    fireEvent.click(screen.getByRole("button", { name: /^Merge$/ }))
    await waitFor(() => expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus()) // never Confirm
    fireEvent.keyDown(screen.getByRole("button", { name: "Cancel" }), { key: "Escape" })
    expect(screen.getByRole("dialog")).toBeInTheDocument() // only the confirm went
    expect(ipc.prMerge).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole("button", { name: /^Merge$/ }))
    fireEvent.click(screen.getByRole("button", { name: /Confirm merge/ }))
    expect(await screen.findByText(/base branch policy prohibits/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole("option", { name: /PR 182/ }))
    expect(await screen.findByText(/It's a draft/)).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /^Merge$/ })).toBeDisabled()
  })

  it("merge: a merge queue took it: said so, never 'Merged'", async () => {
    const id = st().tabs[0]!.activeSessionId
    st().setPaneGit({ [id]: { root: "/w/merge-d" } }, [id])
    answer({ mine: [row(184)] })
    vi.mocked(ipc.prChecks).mockResolvedValue(checks("passed", opts()))
    vi.mocked(ipc.prMerge).mockResolvedValue({ ok: true, row: row(184) }) // still open
    render(<PrDialog />)
    fireEvent.click(await screen.findByRole("button", { name: /^Merge$/ }))
    fireEvent.click(screen.getByRole("button", { name: /Confirm merge/ }))
    expect(await screen.findByText(/hasn't made it yet/)).toBeInTheDocument()
    expect(screen.queryByText(/^Merged/)).toBeNull()
  })

  it("merge: none offered to an account that can't merge there", async () => {
    const id = st().tabs[0]!.activeSessionId
    st().setPaneGit({ [id]: { root: "/w/merge-c" } }, [id])
    answer({ mine: [row(183)] })
    vi.mocked(ipc.prChecks).mockResolvedValue(checks("passed", opts({ canMerge: false })))
    render(<PrDialog />)
    expect(await screen.findByText("build")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /^Merge$/ })).toBeNull()
  })

  it("while checks run: asked again every 15 s; once done, the lists catch up", async () => {
    vi.useFakeTimers()
    try {
      const id = st().tabs[0]!.activeSessionId
      st().setPaneGit({ [id]: { root: "/w/checks-b" } }, [id])
      answer({ mine: [row(171)] })
      vi.mocked(ipc.prChecks).mockResolvedValue(checks("running"))
      render(<PrDialog />)
      await act(async () => {})
      await act(async () => {})
      const asked = vi.mocked(ipc.prChecks).mock.calls.length
      expect(asked).toBeGreaterThan(0)
      const lists = vi.mocked(ipc.prLists).mock.calls.length
      vi.mocked(ipc.prChecks).mockResolvedValue(checks("passed"))
      await act(async () => vi.advanceTimersByTimeAsync(15_000))
      expect(vi.mocked(ipc.prChecks).mock.calls.length).toBe(asked + 1)
      expect(vi.mocked(ipc.prLists).mock.calls.length).toBeGreaterThan(lists) // caught up
      await act(async () => vi.advanceTimersByTimeAsync(30_000))
      expect(vi.mocked(ipc.prChecks).mock.calls.length).toBe(asked + 1) // done: no more
    } finally {
      vi.useRealTimers()
    }
  })
})

describe("PrDialog checks polling", () => {
  const res = (state: "running" | "passed") => ({
    ok: true as const,
    checks: {
      state,
      checks: [{ name: "build", workflow: "CI", state, url: "u" }],
      commits: [],
      moreCommits: 0,
      merge: null,
      branch: NO_BRANCH,
    },
  })

  it("a failed ask while running keeps asking; nothing changing: slower and slower", async () => {
    vi.useFakeTimers()
    try {
      const id = st().tabs[0]!.activeSessionId
      st().setPaneGit({ [id]: { root: "/w/checks-c" } }, [id])
      answer({ mine: [row(172)] })
      vi.mocked(ipc.prChecks).mockResolvedValue(res("running"))
      render(<PrDialog />)
      await act(async () => {})
      await act(async () => {})
      const calls = () => vi.mocked(ipc.prChecks).mock.calls.length
      const start = calls()
      vi.mocked(ipc.prChecks).mockResolvedValueOnce({ ok: false, error: "offline" })
      await act(async () => vi.advanceTimersByTimeAsync(15_000)) // the failed one
      await act(async () => vi.advanceTimersByTimeAsync(60_000))
      expect(calls()).toBeGreaterThan(start + 1) // still asking after the failure
      // unchanged for long: no more often than every 2 minutes
      const before = calls()
      await act(async () => vi.advanceTimersByTimeAsync(10 * 60_000))
      expect(calls() - before).toBeLessThanOrEqual(10) // (every 15 s would be 40)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe("PrDialog PR links", () => {
  it("already listed: selected at once, nothing asked", async () => {
    answer({ mine: [row(193)] })
    render(<PrDialog />)
    await screen.findByRole("option", { name: /PR 193/ })
    act(() => st().openPrLink({ repo: "o/r", number: 193 }))
    expect(screen.getByRole("option", { name: /PR 193/ })).toHaveAttribute("aria-selected", "true")
    expect(ipc.prFind).not.toHaveBeenCalled()
  })

  it("asked with the clicked pane's gh, not the focused one's; refreshed with the lists", async () => {
    const focused = st().tabs[0]!.activeSessionId
    st().setPaneGit({ [focused]: { root: "/w/focused" } }, [focused])
    st().newTab(testShell)
    const other = st().tabs[1]!.activeSessionId
    st().setPaneGit({ [other]: { root: "/w/other" } }, [other])
    st().setActiveTab(st().tabs[0]!.id)
    answer({ mine: [] })
    vi.mocked(ipc.prFind).mockResolvedValue({
      ok: true,
      row: row(301, { repo: "x/y", url: "https://github.com/x/y/pull/301" }),
    })
    st().openPrLink({ repo: "x/y", number: 301 }, other)
    render(<PrDialog />)
    await screen.findByRole("heading", { name: /PR 301/ })
    expect(ipc.prFind).toHaveBeenCalledWith(expect.objectContaining({ cwd: "/w/other" }))
    // its detail and checks with that pane's gh too (the one that found it, as its account)
    await waitFor(() =>
      expect(ipc.prChecks).toHaveBeenCalledWith(
        expect.objectContaining({ number: 301, cwd: "/w/other" }),
      ),
    )
    const now = Date.now()
    vi.spyOn(Date, "now").mockReturnValue(now + 10_000) // (past the just-asked pause)
    vi.mocked(ipc.prFind).mockResolvedValue({
      ok: true,
      row: row(301, { repo: "x/y", url: "https://github.com/x/y/pull/301", title: "Renamed" }),
    })
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "r" })
    expect(await screen.findByRole("heading", { name: /Renamed/ })).toBeInTheDocument()
    vi.restoreAllMocks()
  })

  it("a listed PR: selected where it's listed (another tab too)", async () => {
    answer({ mine: [row(190)], review: [row(191)] })
    st().openPrLink({ repo: "O/R", number: 191 })
    render(<PrDialog />)
    await waitFor(() =>
      expect(screen.getByRole("option", { name: /PR 191/ })).toHaveAttribute(
        "aria-selected",
        "true",
      ),
    )
    expect(screen.getByRole("tab", { name: /Review requested/ })).toHaveAttribute(
      "aria-selected",
      "true",
    )
  })

  it("not listed: asked for on its own, as an account that sees it, shown apart", async () => {
    const id = st().tabs[0]!.activeSessionId
    st().setPaneGit({ [id]: { root: "/w/link-a" } }, [id])
    answer({ mine: [row(192)] })
    vi.mocked(ipc.prFind).mockResolvedValue({
      ok: true,
      row: row(300, { repo: "x/y", url: "https://github.com/x/y/pull/300", account: "work" }),
    })
    st().openPrLink({ repo: "x/y", number: 300 })
    render(<PrDialog />)
    expect(await screen.findByText("From a link: not in these lists.")).toBeInTheDocument()
    expect(ipc.prFind).toHaveBeenCalledWith(
      expect.objectContaining({ repo: "x/y", number: 300, cwd: "/w/link-a" }),
    )
    expect(screen.getByRole("heading", { name: /PR 300/ })).toBeInTheDocument()
    expect(screen.getByRole("option", { name: /PR 192/ })).toHaveAttribute("aria-selected", "false")
    fireEvent.click(screen.getByRole("option", { name: /PR 192/ })) // back to the lists
    expect(screen.queryByText("From a link: not in these lists.")).toBeNull()
    expect(screen.getByRole("heading", { name: /PR 192/ })).toBeInTheDocument()
  })

  it("no account sees it: says which were tried, how to log in, and opens it on GitHub", async () => {
    answer({ mine: [] })
    vi.mocked(ipc.prFind).mockResolvedValue({
      ok: false,
      error: "failed",
      notFound: true,
      tried: ["me", "work"],
    })
    st().openPrLink({ repo: "x/secret", number: 5 })
    render(<PrDialog />)
    expect(
      await screen.findByText(/None of gh's accounts \(@me, @work\) can see x\/secret#5/),
    ).toBeInTheDocument()
    expect(screen.getByText(/gh auth login/)).toBeInTheDocument()
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "o" }) // the keys too
    expect(ipc.openExternal).toHaveBeenCalledWith("https://github.com/x/secret/pull/5")
    vi.mocked(ipc.openExternal).mockClear()
    fireEvent.click(screen.getByRole("button", { name: /Open x\/secret#5 on GitHub/ }))
    expect(ipc.openExternal).toHaveBeenCalledWith("https://github.com/x/secret/pull/5")
  })
})

describe("PrDialog names", () => {
  it("your comments and reviews say (you); the PR's author has a chip", async () => {
    answer({
      mine: [
        row(200, { author: "me", account: "me", reviewers: [{ login: "me", state: "approved" }] }),
      ],
      accounts: [
        { login: "me", active: true, ok: true },
        { login: "work", active: false, ok: true },
      ],
    })
    vi.mocked(ipc.prDetail).mockResolvedValue({
      ok: true,
      detail: {
        url: row(200).url,
        updatedAt: "",
        body: "",
        conversation: [
          { kind: "comment", author: "bob", body: "Ready.", at: "", url: "c1" },
          { kind: "comment", author: "me", body: "Looks good.", at: "", url: "c2" },
          { kind: "comment", author: "work", body: "From work.", at: "", url: "c3" },
        ],
        threads: [],
        links: { closes: [], mentions: [], mentionedBy: [] },
        more: false,
      },
    })
    render(<PrDialog />)
    await screen.findByText("Looks good.")
    const mine = screen.getByText("Looks good.").closest(".pr-comment")!
    expect(mine.querySelector(".pr-you")?.textContent).toBe("me")
    expect(mine.textContent).toContain("(you)")
    expect(mine.textContent).toContain("author") // (you opened it)
    const bobs = screen.getByText("Ready.").closest(".pr-comment")!
    expect(bobs.textContent).not.toMatch(/\(you|author/)
    const work = screen.getByText("From work.").closest(".pr-comment")!
    expect(work.textContent).toContain("work (you · other account)") // another of yours
    expect(document.querySelector(".pr-reviewers")!.textContent).toContain("(you)")
    expect(document.querySelector(".pr-meta")!.textContent).toContain("me (you)") // the summary
  })
})

describe("PrDialog names, a linked PR from another gh", () => {
  it("a WSL pane's link: you are that gh's accounts, not the dialog's", async () => {
    st().newTab({ id: "wsl", label: "Ubuntu", command: "wsl.exe", args: ["-d", "Ubuntu"] })
    const wslPane = st().tabs[1]!.activeSessionId
    st().setActiveTab(st().tabs[0]!.id) // the focused pane: the host's
    answer({ mine: [], accounts: [{ login: "hostme", active: true, ok: true }] })
    vi.mocked(ipc.prAccounts).mockResolvedValue([{ login: "wslme", active: true, ok: true }])
    vi.mocked(ipc.prFind).mockResolvedValue({
      ok: true,
      row: row(310, { repo: "x/y", url: "https://github.com/x/y/pull/310", account: "wslme" }),
    })
    vi.mocked(ipc.prDetail).mockResolvedValue({
      ok: true,
      detail: {
        url: "https://github.com/x/y/pull/310",
        updatedAt: "",
        body: "",
        conversation: [
          { kind: "comment", author: "wslme", body: "Mine in WSL.", at: "", url: "w1" },
          { kind: "comment", author: "hostme", body: "The host's.", at: "", url: "w2" },
        ],
        threads: [],
        links: { closes: [], mentions: [], mentionedBy: [] },
        more: false,
      },
    })
    st().openPrLink({ repo: "x/y", number: 310 }, wslPane)
    render(<PrDialog />)
    await screen.findByText("Mine in WSL.")
    expect(ipc.prAccounts).toHaveBeenCalledWith({ distro: "Ubuntu" })
    await waitFor(() =>
      expect(screen.getByText("Mine in WSL.").closest(".pr-comment")!.textContent).toContain(
        "(you)",
      ),
    )
    expect(screen.getByText("The host's.").closest(".pr-comment")!.textContent).not.toContain(
      "(you",
    )
    vi.mocked(ipc.prAccounts).mockResolvedValue([]) // (the default again)
  })
})

describe("PrDialog branch and draft chips", () => {
  const withBranch = (branch: PrBranchOptions) => ({
    ok: true as const,
    checks: { state: null, checks: [], commits: [], moreCommits: 0, merge: null, branch },
  })
  const CAN: PrBranchOptions = {
    canUpdateBranch: true,
    canEdit: true,
    canClose: false,
    canReopen: false,
    behind: 3,
  }
  const detail = () => document.querySelector(".pr-detail") as HTMLElement

  it("behind base: says how far on hover; a click asks first, then merges the base in", async () => {
    const id = st().tabs[0]!.activeSessionId
    st().setPaneGit({ [id]: { root: "/w/branch-a" } }, [id])
    answer({ mine: [row(195, { merge: "behind", account: "me" })] })
    let updated = false // (its checks asked again after: GitHub counts none behind)
    vi.mocked(ipc.prChecks).mockImplementation(async () =>
      withBranch(updated ? { ...CAN, canUpdateBranch: false, behind: 0 } : CAN),
    )
    vi.mocked(ipc.prBranch).mockImplementation(async () => {
      updated = true
      return {
        ok: true,
        row: row(195, { merge: "unknown", account: "me", updatedAt: "2026-10-16T00:00:00Z" }),
      }
    })
    render(<PrDialog />)
    const chip = await screen.findByRole("button", { name: "behind base: Update branch" })
    expect(chip.getAttribute("title")).toMatch(/^3 commits behind main · click to update/)
    fireEvent.click(chip)
    expect(ipc.prBranch).not.toHaveBeenCalled() // asks first
    expect(screen.getByText("Merge main into b195 as @me?")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus() // (Enter never acts)
    fireEvent.click(screen.getByRole("button", { name: "Update branch" }))
    await waitFor(() =>
      expect(ipc.prBranch).toHaveBeenCalledWith(
        expect.objectContaining({ repo: "o/r", number: 195, action: "update", account: "me" }),
      ),
    )
    expect(await screen.findByText("Branch updated: main merged in.")).toBeInTheDocument()
    await waitFor(() => expect(detail().textContent).not.toContain("behind base"))
    expect(ipc.prChecks).toHaveBeenLastCalledWith(expect.objectContaining({ behind: true }))
  })

  it("a draft: ready for review; open: back to draft; Esc backs out", async () => {
    const id = st().tabs[0]!.activeSessionId
    st().setPaneGit({ [id]: { root: "/w/branch-b" } }, [id])
    answer({ mine: [row(196, { state: "draft" })] })
    vi.mocked(ipc.prChecks).mockResolvedValue(withBranch(CAN))
    vi.mocked(ipc.prBranch).mockResolvedValue({
      ok: true,
      row: row(196, { updatedAt: "2026-10-16T00:00:00Z" }),
    })
    render(<PrDialog />)
    const draft = await screen.findByRole("button", { name: "draft: Ready for review" })
    fireEvent.click(draft)
    fireEvent.keyDown(screen.getByRole("button", { name: "Cancel" }), { key: "Escape" })
    expect(screen.queryByText(/ready for review\?/)).toBeNull()
    expect(screen.getByRole("dialog")).toBeInTheDocument() // (Esc left the step, not the dialog)
    fireEvent.click(draft)
    fireEvent.click(screen.getByRole("button", { name: "Ready for review" }))
    await waitFor(() =>
      expect(ipc.prBranch).toHaveBeenCalledWith(expect.objectContaining({ action: "ready" })),
    )
    expect(await screen.findByText("Marked ready for review.")).toBeInTheDocument()
    // open now: its own chip turns it back into a draft
    expect(screen.getByRole("button", { name: "open: Convert to draft" })).toBeInTheDocument()
  })

  it("nothing offered to an account GitHub won't let; a refusal shows gh's words", async () => {
    const id = st().tabs[0]!.activeSessionId
    st().setPaneGit({ [id]: { root: "/w/branch-c" } }, [id])
    answer({ mine: [row(197, { merge: "behind" }), row(198, { merge: "behind" })] })
    vi.mocked(ipc.prChecks).mockImplementation(async (r) =>
      withBranch(r.number === 197 ? { ...CAN, canUpdateBranch: false, canEdit: false } : CAN),
    )
    vi.mocked(ipc.prBranch).mockResolvedValue({
      ok: false,
      error: "failed",
      message: "GraphQL: merge conflict between base and head",
    })
    render(<PrDialog />)
    await waitFor(() => expect(detail().textContent).toContain("behind base"))
    await waitFor(() => expect(ipc.prChecks).toHaveBeenCalled())
    expect(screen.queryByRole("button", { name: /behind base/ })).toBeNull()
    expect(detail().querySelector('[title*="doesn\'t let this account"]')).not.toBeNull()
    fireEvent.click(screen.getByRole("option", { name: /PR 198/ }))
    fireEvent.click(await screen.findByRole("button", { name: "behind base: Update branch" }))
    fireEvent.click(screen.getByRole("button", { name: "Update branch" }))
    expect(await screen.findByText(/merge conflict between base and head/)).toBeInTheDocument()
  })

  it("behind by GitHub's count though its merge state is clean; pending, the rest still act", async () => {
    const id = st().tabs[0]!.activeSessionId
    st().setPaneGit({ [id]: { root: "/w/branch-d" } }, [id])
    answer({ mine: [row(199, { merge: "clean" })] })
    vi.mocked(ipc.prChecks).mockResolvedValue(withBranch({ ...CAN, behind: 1 }))
    vi.mocked(ipc.prBranch).mockResolvedValue({ ok: true, row: row(199), pending: true })
    render(<PrDialog />)
    const chip = await screen.findByRole("button", { name: "behind base: Update branch" })
    expect(chip.getAttribute("title")).toMatch(/^1 commit behind main/)
    // (the list says what GitHub's merge state says: nothing)
    expect(screen.getByRole("option", { name: /PR 199/ }).textContent).not.toContain("behind")
    fireEvent.click(chip)
    fireEvent.click(screen.getByRole("button", { name: "Update branch" }))
    expect(await screen.findByText("updating branch…")).toBeInTheDocument()
    expect(screen.getByText(/GitHub is merging main in/)).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /Update branch/ })).toBeNull()
    expect(screen.getByRole("button", { name: "open: Convert to draft" })).toBeInTheDocument()
  })

  it("while a branch action runs, no merge; the confirm goes when GitHub stops offering it", async () => {
    const id = st().tabs[0]!.activeSessionId
    st().setPaneGit({ [id]: { root: "/w/branch-e" } }, [id])
    answer({ mine: [row(185, { merge: "behind" }), row(186, { merge: "behind" })] })
    const opts: PrMergeOptions = {
      methods: ["merge"],
      preferred: "merge",
      canMerge: true,
      head: "",
    }
    let canUpdate = true
    vi.mocked(ipc.prChecks).mockImplementation(async () => ({
      ok: true as const,
      checks: {
        state: null,
        checks: [],
        commits: [],
        moreCommits: 0,
        merge: opts,
        branch: { ...CAN, canUpdateBranch: canUpdate },
      },
    }))
    let release = () => {}
    vi.mocked(ipc.prBranch).mockImplementation(
      () =>
        new Promise((r) => {
          release = () => r({ ok: true, row: row(185), behind: 0 })
        }),
    )
    render(<PrDialog />)
    fireEvent.click(await screen.findByRole("button", { name: "behind base: Update branch" }))
    fireEvent.click(screen.getByRole("button", { name: "Update branch" }))
    expect(await screen.findByText("Another change to it is running.")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /^Merge$/ })).toBeDisabled()
    await act(async () => release())
    // another PR: someone else updated it meanwhile (GitHub no longer offers it)
    fireEvent.click(screen.getByRole("option", { name: /PR 186/ }))
    fireEvent.click(await screen.findByRole("button", { name: "behind base: Update branch" }))
    expect(screen.getByText(/Merge main into b186/)).toBeInTheDocument()
    canUpdate = false // (a push to it: its checks asked again)
    answer({
      mine: [
        row(185, { merge: "behind" }),
        row(186, { merge: "behind", updatedAt: "2026-10-16T01:00:00Z" }),
      ],
    })
    fireEvent.click(screen.getByTitle("Refresh (r)"))
    await waitFor(() => expect(screen.queryByText(/Merge main into b186/)).toBeNull())
  })
})

describe("PrDialog repo and branch names", () => {
  it("a repo's name opens it on GitHub (a row's, without selecting it); a branch's copies", async () => {
    answer({
      mine: [row(400), row(401, { repo: "x/lib", url: "https://github.com/x/lib/pull/401" })],
    })
    render(<PrDialog />)
    const second = await screen.findByRole("option", { name: /PR 401/ })
    fireEvent.click(second.querySelector(".pr-repo-link")!)
    expect(ipc.openExternal).toHaveBeenLastCalledWith("https://github.com/x/lib")
    expect(second).toHaveAttribute("aria-selected", "false") // (the row stays as it was)
    fireEvent.click(screen.getByRole("button", { name: /^b400/ }))
    expect(ipc.clipboardWrite).toHaveBeenLastCalledWith("b400")
    expect(screen.getByRole("button", { name: /^b400/ })).toHaveAttribute("title", "Copied")
    fireEvent.click(screen.getByRole("button", { name: /^main/ }))
    expect(ipc.clipboardWrite).toHaveBeenLastCalledWith("main")
    expect(screen.getByRole("dialog")).toHaveFocus() // (Enter opens the PR again)
    // a double-click on a row's repo name: the repo, never the PR too
    vi.mocked(ipc.openExternal).mockClear()
    fireEvent.doubleClick(second.querySelector(".pr-repo-link")!)
    expect(ipc.openExternal).not.toHaveBeenCalledWith(row(401).url)
  })

  it("the copied mark is that branch's: another PR's branch never shows it", async () => {
    answer({ mine: [row(402), row(403)] })
    render(<PrDialog />)
    await screen.findByRole("option", { name: /PR 402/ })
    fireEvent.click(screen.getByRole("button", { name: /^b402/ }))
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "j" })
    expect(screen.getByRole("button", { name: /^b403/ })).not.toHaveAttribute("title", "Copied")
  })
})

describe("PrDialog close and reopen", () => {
  const withBranch = (branch: PrBranchOptions) => ({
    ok: true as const,
    checks: { state: null, checks: [], commits: [], moreCommits: 0, merge: null, branch },
  })
  const opts = (over: Partial<PrBranchOptions>): PrBranchOptions => ({
    canUpdateBranch: false,
    canEdit: false,
    canClose: false,
    canReopen: false,
    behind: 0,
    ...over,
  })

  it("an open PR: the icon at the status line's end asks first, then closes it", async () => {
    const id = st().tabs[0]!.activeSessionId
    st().setPaneGit({ [id]: { root: "/w/close-a" } }, [id])
    answer({ mine: [row(500, { account: "me" })] })
    let isClosed = false
    vi.mocked(ipc.prChecks).mockImplementation(async () =>
      withBranch(opts(isClosed ? { canReopen: true } : { canClose: true })),
    )
    const closedRow = row(500, {
      state: "closed",
      account: "me",
      updatedAt: "2026-10-19T00:00:00Z",
    })
    vi.mocked(ipc.prBranch).mockImplementation(async () => {
      isClosed = true
      answer({ mine: [] }) // (the next refresh: open ones only, it's gone)
      return { ok: true, row: closedRow }
    })
    render(<PrDialog />)
    // (open ones only: what the dialog remembers from before may have closed ones on)
    const all = screen.getByRole("checkbox", { name: /Include closed/ }) as HTMLInputElement
    if (all.checked) fireEvent.click(all)
    const icon = await screen.findByRole("button", { name: "Close pull request…" })
    expect(icon).toHaveAttribute("title", "Close this pull request")
    fireEvent.click(icon)
    expect(ipc.prBranch).not.toHaveBeenCalled() // asks first
    expect(
      screen.getByText("Close #500 without merging as @me? It can be reopened later."),
    ).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus()
    fireEvent.click(screen.getByRole("button", { name: "Close pull request" }))
    await waitFor(() =>
      expect(ipc.prBranch).toHaveBeenCalledWith(
        expect.objectContaining({ repo: "o/r", number: 500, action: "close", account: "me" }),
      ),
    )
    // The lists (open ones only) drop it; the banner keeps the way back, as the same account
    const banner = () => document.querySelector(".pr-closed-banner") as HTMLElement | null
    await waitFor(() => expect(banner()?.textContent).toContain("Closed o/r#500 PR 500"))
    await waitFor(() => expect(screen.queryByRole("option", { name: /PR 500/ })).toBeNull())
    const reopened = row(500, { account: "me", updatedAt: "2026-10-19T01:00:00Z" })
    vi.mocked(ipc.prBranch).mockImplementation(async () => {
      isClosed = false
      answer({ mine: [reopened] })
      return { ok: true, row: reopened }
    })
    fireEvent.click(screen.getByRole("button", { name: /^Reopen$/ }))
    expect(screen.getByText("Reopen #500 as @me?")).toBeInTheDocument() // asks first
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus()
    fireEvent.click(screen.getByRole("button", { name: "Reopen pull request" }))
    await waitFor(() =>
      expect(ipc.prBranch).toHaveBeenLastCalledWith(
        expect.objectContaining({ number: 500, action: "reopen", account: "me" }),
      ),
    )
    expect(await screen.findByRole("option", { name: /PR 500/ })).toBeInTheDocument() // listed again
    expect(banner()).toBeNull()
  })

  it("a search still listing it (GitHub lags): the open lists drop it all the same", async () => {
    answer({ mine: [row(540, { account: "me" }), row(541, { account: "me" })] })
    vi.mocked(ipc.prChecks).mockResolvedValue(withBranch(opts({ canClose: true })))
    vi.mocked(ipc.prBranch).mockResolvedValue({
      ok: true,
      row: row(540, { state: "closed", account: "me", updatedAt: "2026-10-19T00:00:00Z" }),
    })
    render(<PrDialog />)
    const all = screen.getByRole("checkbox", { name: /Include closed/ }) as HTMLInputElement
    if (all.checked) fireEvent.click(all)
    await screen.findByRole("heading", { name: /PR 540/ })
    fireEvent.click(await screen.findByRole("button", { name: "Close pull request…" }))
    fireEvent.click(screen.getByRole("button", { name: "Close pull request" }))
    await waitFor(() => expect(screen.queryByRole("option", { name: /PR 540/ })).toBeNull())
    expect(screen.getByRole("option", { name: /PR 541/ })).toHaveAttribute("aria-selected", "true")
    expect(document.querySelector(".pr-closed-banner")!.textContent).toContain("Closed o/r#540")
  })

  it("the banner's reopen: Esc and Cancel back out; a row coming back drops its prompt", async () => {
    answer({ mine: [row(550, { account: "me" })] })
    vi.mocked(ipc.prChecks).mockResolvedValue(withBranch(opts({ canClose: true })))
    const closedRow = row(550, {
      state: "closed",
      account: "me",
      updatedAt: "2026-10-19T00:00:00Z",
    })
    vi.mocked(ipc.prBranch).mockImplementation(async () => {
      answer({ mine: [] })
      return { ok: true, row: null } // (closed; its row not fetched after)
    })
    render(<PrDialog />)
    const all = screen.getByRole("checkbox", { name: /Include closed/ }) as HTMLInputElement
    if (all.checked) fireEvent.click(all)
    await screen.findByRole("heading", { name: /PR 550/ })
    fireEvent.click(await screen.findByRole("button", { name: "Close pull request…" }))
    const checksBefore = vi.mocked(ipc.prChecks).mock.calls.length
    fireEvent.click(screen.getByRole("button", { name: "Close pull request" }))
    const reopen = await screen.findByRole("button", { name: /^Reopen$/ })
    // no row back: what it offers now is asked again
    expect(vi.mocked(ipc.prChecks).mock.calls.length).toBeGreaterThan(checksBefore)
    fireEvent.click(reopen)
    fireEvent.keyDown(screen.getByRole("button", { name: "Cancel" }), { key: "Escape" })
    expect(screen.getByRole("dialog")).toBeInTheDocument() // (only the prompt went)
    expect(screen.queryByText("Reopen #550 as @me?")).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: /^Reopen$/ }))
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }))
    expect(screen.queryByText("Reopen #550 as @me?")).toBeNull()
    // asked again, then the lists show it (closed ones listed): its prompt goes with it
    fireEvent.click(screen.getByRole("button", { name: /^Reopen$/ }))
    answer({ mine: [closedRow] })
    fireEvent.click(all)
    await screen.findByRole("option", { name: /PR 550/ })
    answer({ mine: [] })
    fireEvent.click(all)
    await waitFor(() => expect(screen.queryByRole("option", { name: /PR 550/ })).toBeNull())
    expect(await screen.findByRole("button", { name: /^Reopen$/ })).toBeInTheDocument()
    expect(screen.queryByText("Reopen #550 as @me?")).toBeNull()
  })

  it("the banner's ×: no reopen offered for it any more", async () => {
    answer({ mine: [row(530, { account: "me" })] })
    vi.mocked(ipc.prChecks).mockResolvedValue(withBranch(opts({ canClose: true })))
    vi.mocked(ipc.prBranch).mockImplementation(async () => {
      answer({ mine: [] })
      return { ok: true, row: row(530, { state: "closed", updatedAt: "2026-10-19T00:00:00Z" }) }
    })
    render(<PrDialog />)
    const all = screen.getByRole("checkbox", { name: /Include closed/ }) as HTMLInputElement
    if (all.checked) fireEvent.click(all)
    await screen.findByRole("heading", { name: /PR 530/ }) // (its own answer, not the last one's)
    fireEvent.click(await screen.findByRole("button", { name: "Close pull request…" }))
    fireEvent.click(screen.getByRole("button", { name: "Close pull request" }))
    fireEvent.click(await screen.findByRole("button", { name: "Dismiss: closed #530" }))
    expect(document.querySelector(".pr-closed-banner")).toBeNull()
  })

  it("closed while the user moved on: the PR they're on now stays", async () => {
    answer({ mine: [row(510, { account: "me" }), row(511, { account: "me" })] })
    vi.mocked(ipc.prChecks).mockResolvedValue(withBranch(opts({ canClose: true })))
    let finish: (v: Awaited<ReturnType<typeof ipc.prBranch>>) => void = () => {}
    vi.mocked(ipc.prBranch).mockImplementation(() => new Promise((r) => (finish = r)))
    render(<PrDialog />)
    const all = screen.getByRole("checkbox", { name: /Include closed/ }) as HTMLInputElement
    if (all.checked) fireEvent.click(all)
    await screen.findByRole("heading", { name: /PR 510/ })
    fireEvent.click(await screen.findByRole("button", { name: "Close pull request…" }))
    fireEvent.click(screen.getByRole("button", { name: "Close pull request" }))
    fireEvent.click(screen.getByRole("option", { name: /PR 511/ })) // moved on meanwhile
    answer({ mine: [row(511, { account: "me" })] })
    await act(async () =>
      finish({ ok: true, row: row(510, { state: "closed", updatedAt: "2026-10-19T00:00:00Z" }) }),
    )
    await waitFor(() => expect(screen.queryByRole("option", { name: /PR 510/ })).toBeNull())
    expect(screen.getByRole("heading", { name: /PR 511/ })).toBeInTheDocument()
    expect(document.querySelector(".pr-closed-banner")!.textContent).toContain("Closed o/r#510")
  })

  it("a closed PR offers reopen; none for an account GitHub doesn't let", async () => {
    answer({ mine: [row(501, { state: "closed" }), row(502)] })
    vi.mocked(ipc.prChecks).mockImplementation(async (r) =>
      withBranch(r.number === 501 ? opts({ canReopen: true }) : opts({})),
    )
    render(<PrDialog />)
    const all = screen.getByRole("checkbox", { name: /Include closed/ }) as HTMLInputElement
    if (!all.checked) fireEvent.click(all) // (closed ones listed: 501 among them)
    expect(await screen.findByRole("button", { name: "Reopen pull request…" })).toBeInTheDocument()
    fireEvent.click(screen.getByRole("option", { name: /PR 502/ }))
    await waitFor(() =>
      expect(ipc.prChecks).toHaveBeenCalledWith(expect.objectContaining({ number: 502 })),
    )
    expect(
      screen.queryByRole("button", { name: /Close pull request|Reopen pull request/ }),
    ).toBeNull()
  })
})

describe("PrDialog labels", () => {
  const labels = ["bug", "ui", "perf", "docs", "infra"].map((name) => ({
    name,
    color: "d73a4a",
    description: name === "bug" ? "Something isn't working" : "",
  }))

  it("a row's first three and how many more; all in its detail; a click opens them on GitHub", async () => {
    answer({ mine: [row(600), row(601, { labels, moreLabels: 1 })] })
    render(<PrDialog />)
    const second = await screen.findByRole("option", { name: /PR 601/ })
    const inRow = [...second.querySelectorAll(".pr-label")].map((e) => e.textContent)
    expect(inRow).toEqual(["bug", "ui", "perf"])
    expect(second.querySelector(".pr-label-more")!.textContent).toBe("+3") // (2 not shown, 1 not asked)
    expect(second.querySelector(".pr-label-more")).toHaveAttribute(
      "title",
      "docs, infra, and 1 more on GitHub",
    )
    fireEvent.click(second.querySelector(".pr-label")!)
    expect(ipc.openExternal).toHaveBeenLastCalledWith(
      "https://github.com/o/r/pulls?q=is%3Apr%20label%3A%22bug%22",
    )
    expect(second).toHaveAttribute("aria-selected", "false") // (the row stays as it was)
    fireEvent.click(second)
    const detail = document.querySelector(".pr-labels")!
    expect([...detail.querySelectorAll(".pr-label")].map((e) => e.textContent)).toEqual(
      labels.map((l) => l.name),
    )
    expect(screen.getByRole("button", { name: "bug" })).toHaveAttribute(
      "title",
      "bug: Something isn't working · open o/r's PRs with it",
    )
  })
})

describe("PrDialog graph view", () => {
  const toGraph = async () => {
    fireEvent.click(await screen.findByRole("button", { name: /^Graph/ }))
    return screen.getByRole("listbox", { name: "Pull requests graph" })
  }

  it("the switch shows the graph, a root per repo with its default branch; kept across opens", async () => {
    answer({
      mine: [
        row(1, { defaultBranch: "main" }),
        row(2, { base: "b1", defaultBranch: "main" }),
        row(3, { repo: "a/x", url: "https://github.com/a/x/pull/3", defaultBranch: "develop" }),
      ],
    })
    const { unmount } = render(<PrDialog />)
    await screen.findByRole("option", { name: /PR 1/ })
    await toGraph()
    expect(screen.getByRole("option", { name: /#2 PR 2/ })).toBeInTheDocument()
    expect(screen.getByText("o/r")).toBeInTheDocument()
    expect(screen.getByText("a/x")).toBeInTheDocument()
    expect(screen.getByText(/develop/)).toBeInTheDocument()
    expect(localStorage.getItem("minmux.prDialog.view")).toBe("graph")
    unmount()
    render(<PrDialog />)
    expect(await screen.findByRole("listbox", { name: "Pull requests graph" })).toBeInTheDocument()
  })

  it("a card's state: its word, the approved tick, the comment count", async () => {
    answer({
      mine: [
        row(1, { merge: "conflicts", comments: 4 }),
        row(2, { ci: "pending", review: "approved" }),
      ],
    })
    render(<PrDialog />)
    await screen.findByRole("option", { name: /PR 1/ })
    await toGraph()
    expect(screen.getByRole("option", { name: "#1 PR 1, conflicts" })).toBeInTheDocument()
    expect(
      screen.getByRole("option", { name: "#2 PR 2, CI running, approved" }),
    ).toBeInTheDocument()
    expect(screen.getByTitle("4 comments")).toBeInTheDocument()
  })

  it("a card opens its PR in the list, which isn't kept as the view; ↗ opens GitHub", async () => {
    answer({ mine: [row(1), row(2)] })
    render(<PrDialog />)
    await screen.findByRole("option", { name: /PR 1/ })
    await toGraph()
    fireEvent.click(screen.getByRole("button", { name: "Open #2 on GitHub" }))
    expect(ipc.openExternal).toHaveBeenCalledWith("https://github.com/o/r/pull/2")
    fireEvent.click(screen.getByRole("button", { name: "Open #2 in the list" }))
    expect(screen.getByRole("option", { name: /PR 2/ })).toHaveAttribute("aria-selected", "true")
    expect(screen.queryByRole("listbox", { name: "Pull requests graph" })).toBeNull()
    expect(localStorage.getItem("minmux.prDialog.view")).toBe("graph")
  })

  it("keys: arrows move in the graph, tabs stay on digits, Enter opens, g switches", async () => {
    answer({ mine: [row(1), row(2, { base: "b1" }), row(3)], review: [row(9)] })
    render(<PrDialog />)
    await screen.findByRole("option", { name: /PR 1/ })
    const dialog = screen.getByRole("dialog")
    fireEvent.keyDown(dialog, { key: "g" })
    const sel = () =>
      screen.getAllByRole("option").find((o) => o.getAttribute("aria-selected") === "true")
    expect(sel()).toHaveAccessibleName(/^#1/)
    fireEvent.keyDown(dialog, { key: "ArrowRight" })
    expect(sel()).toHaveAccessibleName(/^#2/) // stacked on 1, not the next tab
    expect(screen.getByRole("tab", { name: /Mine/ })).toHaveAttribute("aria-selected", "true")
    fireEvent.keyDown(dialog, { key: "ArrowDown" })
    expect(sel()).toHaveAccessibleName(/^#3/)
    fireEvent.keyDown(dialog, { key: "ArrowUp" })
    fireEvent.keyDown(dialog, { key: "ArrowLeft" })
    expect(sel()).toHaveAccessibleName(/^#1/)
    fireEvent.keyDown(dialog, { key: "Enter" })
    expect(screen.getByRole("option", { name: /PR 1/ })).toHaveAttribute("aria-selected", "true")
    expect(ipc.openExternal).not.toHaveBeenCalled()
    fireEvent.keyDown(dialog, { key: "g" })
    fireEvent.keyDown(dialog, { key: "2" })
    expect(screen.getByRole("tab", { name: /Review/ })).toHaveAttribute("aria-selected", "true")
  })

  it("roots: the focused repo's opens its tab; another repo's opens GitHub", async () => {
    answer({
      mine: [row(1), row(3, { repo: "a/x", url: "https://github.com/a/x/pull/3" })],
      repo: [row(1)],
      repoName: "o/r",
    })
    render(<PrDialog />)
    await screen.findByRole("option", { name: /PR 1/ })
    await toGraph()
    fireEvent.click(screen.getByRole("button", { name: /^a\/x/ }))
    expect(ipc.openExternal).toHaveBeenCalledWith("https://github.com/a/x")
    fireEvent.click(screen.getByRole("button", { name: /^o\/r/ }))
    expect(screen.getByRole("tab", { name: /o\/r/ })).toHaveAttribute("aria-selected", "true")
    expect(screen.queryByRole("listbox", { name: "Pull requests graph" })).toBeNull()
  })

  it("a PR link switches to the list (its detail is there), the view picked stays saved", async () => {
    answer({ mine: [row(1), row(2)] })
    render(<PrDialog />)
    await screen.findByRole("option", { name: /PR 1/ })
    await toGraph()
    act(() => st().openPrLink({ repo: "o/r", number: 2 }))
    await waitFor(() =>
      expect(screen.getByRole("option", { name: /PR 2/ })).toHaveAttribute("aria-selected", "true"),
    )
    expect(screen.queryByRole("listbox", { name: "Pull requests graph" })).toBeNull()
    expect(localStorage.getItem("minmux.prDialog.view")).toBe("graph")
  })
})

describe("PrDialog graph view, empty", () => {
  it("an empty tab says so in the graph, and the arrows still switch tabs", async () => {
    localStorage.setItem("minmux.prDialog.view", "graph")
    answer({ mine: [row(1)], review: [] })
    render(<PrDialog />)
    const dialog = screen.getByRole("dialog")
    await screen.findByRole("option", { name: /^#1/ })
    fireEvent.keyDown(dialog, { key: "2" })
    expect(await screen.findByText("No pull requests wait for your review.")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /Graph/ })).toHaveAttribute("aria-pressed", "true")
    fireEvent.keyDown(dialog, { key: "ArrowLeft" })
    expect(screen.getByRole("tab", { name: /Mine/ })).toHaveAttribute("aria-selected", "true")
  })
})

describe("PrDialog worktrees not open", () => {
  it("asked once on open and once per refresh finished, never per tab answering", async () => {
    const id = st().tabs[0]!.activeSessionId
    st().setPaneGit({ [id]: { root: "/w/r", branch: "main" } }, [id])
    answer({ mine: [row(1)], review: [row(2)], repo: [row(3)], repoName: "o/r" })
    render(<PrDialog />)
    await screen.findByRole("option", { name: /PR 1/ })
    await waitFor(() => expect(ipc.prLists).toHaveBeenCalledTimes(3))
    await act(async () => {})
    expect(ipc.prLocal).toHaveBeenCalledTimes(2)
  })

  it("a PR's branch in a worktree with no terminal: on its card, in its detail, opened there", async () => {
    const id = st().tabs[0]!.activeSessionId
    st().setPaneGit({ [id]: { root: "/w/r", branch: "main" } }, [id])
    vi.mocked(ipc.prLocal).mockResolvedValue({
      ok: true,
      repos: [
        {
          repo: "o/r",
          worktrees: [
            { path: "/w/r", branch: "main" },
            { path: "/w/r/.worktrees/tab", branch: "b1" },
          ],
        },
      ],
    })
    answer({ mine: [row(1), row(2)] })
    render(<PrDialog />)
    await screen.findByRole("option", { name: /PR 1/ })
    expect(ipc.prLocal).toHaveBeenCalledWith({ roots: ["/w/r"] })
    // the detail: the worktree, with the way into it
    await waitFor(() => expect(ipc.prLocal).toHaveBeenCalled())
    const open = await screen.findByRole("button", { name: /tab worktree · open a terminal here/ })
    // the graph card says so too (the pane's own checkout isn't listed again: main has a pane)
    fireEvent.click(screen.getByRole("button", { name: /^Graph/ }))
    expect(screen.getByText(/tab · worktree, not open/)).toBeInTheDocument()
    expect(screen.queryAllByText(/worktree, not open/)).toHaveLength(1)
    fireEvent.click(screen.getByRole("button", { name: /^List/ }))
    fireEvent.click(await screen.findByRole("button", { name: /open a terminal here/ }))
    expect(open).toBeTruthy()
    expect(st().prDialogOpen).toBe(false)
    expect(Object.values(st().sessions).some((x) => x.cwd === "/w/r/.worktrees/tab")).toBe(true)
  })
})
