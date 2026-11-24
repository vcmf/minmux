import { describe, it, expect } from "vitest"
import {
  countMergedUnits,
  folderName,
  hostPathOfWsl,
  openUnder,
  parseLocalRequest,
  parseWorktrees,
  progressOf,
  worktreeCheckouts,
} from "./pr-local"
import type { PrRow } from "./pr-dashboard"

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

describe("parseWorktrees", () => {
  it("each worktree on a branch; bare, detached and prunable ones left out", () => {
    const out = [
      "worktree /w/r",
      "HEAD 1111",
      "branch refs/heads/main",
      "",
      "worktree /w/r-b1",
      "HEAD 2222",
      "branch refs/heads/feat/x",
      "locked",
      "",
      "worktree /w/r-det",
      "HEAD 3333",
      "detached",
      "",
      "worktree /w/gone",
      "HEAD 4444",
      "branch refs/heads/b9",
      "prunable gitdir file points to non-existent location",
      "",
      "worktree /w/bare.git",
      "bare",
      "",
    ].join("\n")
    expect(parseWorktrees(out)).toEqual([
      { path: "/w/r", branch: "main" },
      { path: "/w/r-b1", branch: "feat/x" },
    ])
  })

  it("Windows line ends; nothing parseable: none", () => {
    expect(parseWorktrees("worktree C:/w/r\r\nHEAD 1\r\nbranch refs/heads/b1\r\n")).toEqual([
      { path: "C:/w/r", branch: "b1" },
    ])
    expect(parseWorktrees("")).toEqual([])
    expect(parseWorktrees("fatal: not a git repository")).toEqual([])
  })
})

describe("worktreeCheckouts", () => {
  const repos = [
    {
      repo: "O/R",
      worktrees: [
        { path: "/w/r", branch: "main" },
        { path: "/w/r-1", branch: "b1" },
        { path: "/w/r-2", branch: "b2" },
        { path: "/w/r-3", branch: "b3" },
      ],
    },
    { repo: null, worktrees: [{ path: "/w/x", branch: "b1" }] },
  ]

  it("a PR's branch in a worktree no pane is in (repo names in any case)", () => {
    const m = worktreeCheckouts(repos, [row(1), row(2), row(4)], ["/w/r", "/w/r-2/"])
    expect([...m]).toEqual([[row(1).url, ["/w/r-1"]]]) // r-2 has a pane; b4 isn't checked out
  })

  it("never a fork's PR, nor another repo's branch of the same name", () => {
    const m = worktreeCheckouts(
      repos,
      [row(3, { fork: true }), row(1, { repo: "a/b", url: "u" })],
      [],
    )
    expect(m.size).toBe(0)
  })

  it("the same worktree listed twice (two roots of one repo): once", () => {
    const twice = [repos[0]!, repos[0]!]
    expect(worktreeCheckouts(twice, [row(1)], []).get(row(1).url)).toEqual(["/w/r-1"])
  })
})

describe("Windows paths", () => {
  it("a WSL pane's /mnt/c path is the host's C:/ one; a pane on it hides the worktree", () => {
    expect(hostPathOfWsl("/mnt/c/w/r-wt")).toBe("C:/w/r-wt")
    expect(hostPathOfWsl("/mnt/d")).toBe("D:/")
    expect(hostPathOfWsl("/home/me/r")).toBeNull()
    const repos = [{ repo: "o/r", worktrees: [{ path: "C:/w/r-wt", branch: "b1" }] }]
    expect(worktreeCheckouts(repos, [row(1)], ["C:/w/r-wt"]).size).toBe(0)
    expect(worktreeCheckouts(repos, [row(1)], ["c:\\w\\r-wt\\"]).size).toBe(0)
  })
})

describe("folderName", () => {
  it("the last part of a folder", () => {
    expect(folderName("/w/term/.worktrees/x/")).toBe("x")
    expect(folderName("C:\\w\\r")).toBe("r")
  })
})

describe("countMergedUnits", () => {
  const gh = (subject: string) => `noreply@github.com\0${subject}`
  it("GitHub's squash and merge commits, each PR once", () => {
    const out = [
      gh("feat(x): one (#12)"),
      gh("Merge pull request #13 from me/b13"),
      gh("Merge pull request #13 from me/b13"), // (the same PR: once)
      gh("Merge branch 'main' into b1"), // GitHub's "Update branch": no PR
      "me@example.com\0fix: hand-written (#99)", // someone's own commit naming an issue
      "me@example.com\0Merge pull request #7 from x/y", // a cherry-pick: not GitHub's
      "",
    ].join("\r\n")
    expect(countMergedUnits(out)).toBe(2)
  })

  it("nothing of GitHub's, or not an answer: none", () => {
    expect(countMergedUnits("")).toBe(0)
    expect(countMergedUnits("fatal: bad revision")).toBe(0)
  })
})

describe("openUnder", () => {
  it("the open and draft PRs stacked on it, at any depth; closed ones and forks' bases aside", () => {
    const rows = [
      row(1),
      row(2, { base: "b1" }),
      row(3, { base: "b2", state: "draft" }),
      row(4, { base: "b1", state: "merged" }), // merged: not open (its stack still walked)
      row(5, { base: "b4" }),
      row(6),
    ]
    expect(openUnder(rows[0]!, rows)).toBe(3) // 2, 3, 5
    expect(openUnder(rows[5]!, rows)).toBe(0)
  })

  it("a cycle ends", () => {
    const rows = [row(1, { base: "b2" }), row(2, { base: "b1" })]
    expect(openUnder(rows[0]!, rows)).toBe(1)
  })
})

describe("progressOf", () => {
  it("shown when main counted and there's something to show", () => {
    expect(progressOf(undefined, 3)).toBeNull() // no remote refs: never a guess
    expect(progressOf(0, 0)).toBeNull()
    expect(progressOf(2, 1)).toEqual({ merged: 2, open: 1 })
    expect(progressOf(0, 2)).toEqual({ merged: 0, open: 2 })
  })
})

describe("parseLocalRequest", () => {
  it("roots and the PRs to count, each checked; anything else: not a request", () => {
    expect(parseLocalRequest(null)).toBeNull()
    expect(parseLocalRequest({ roots: "x" })).toBeNull()
    expect(parseLocalRequest({ roots: ["/w/r", 3, ""] })).toEqual({ roots: ["/w/r"] })
    expect(
      parseLocalRequest({
        roots: ["/w/r"],
        prs: [
          { repo: "o/r", head: "b1", base: "main", defaultBranch: "main" },
          { repo: "o/r", head: "b2", base: "b1", defaultBranch: 7 },
          { repo: "o/r", head: "", base: "main" },
          null,
        ],
      }),
    ).toEqual({
      roots: ["/w/r"],
      prs: [
        { repo: "o/r", head: "b1", base: "main", defaultBranch: "main" },
        { repo: "o/r", head: "b2", base: "b1" },
      ],
    })
  })
})
