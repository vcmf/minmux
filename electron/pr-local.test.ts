import { describe, it, expect, vi } from "vitest"
import { PrLocal as RealPrLocal, type DirExists, type GitRunner } from "./pr-local"

// Every folder exists unless a test says otherwise.
class PrLocal extends RealPrLocal {
  constructor(run: GitRunner, now?: () => number, exists: DirExists = async () => true) {
    super(run, now, exists)
  }
}

// A fake git: two worktrees of one repo (/w/r and /w/r-wt), and a repo with no GitHub remote.
function fakeGit(over: Partial<Record<string, string | Error>> = {}) {
  const answers: Record<string, string | Error> = {
    "/w/r rev-parse --git-common-dir": ".git\n",
    "/w/r-wt rev-parse --git-common-dir": "/w/r/.git\n",
    "/w/r worktree list --porcelain":
      "worktree /w/r\nHEAD 1\nbranch refs/heads/main\n\nworktree /w/r-wt\nHEAD 2\nbranch refs/heads/b1\n",
    "/w/r remote -v": "origin\tgit@github.com:o/r.git (fetch)\n",
    "/w/l rev-parse --git-common-dir": ".git\n",
    "/w/l worktree list --porcelain": "worktree /w/l\nHEAD 3\nbranch refs/heads/x\n",
    "/w/l remote -v": "",
    ...over,
  }
  const run = vi.fn<GitRunner>(async (args, cwd) => {
    const a = answers[`${cwd} ${args.join(" ")}`]
    if (a === undefined || a instanceof Error) throw a ?? new Error(`no answer: ${cwd} ${args}`)
    return a
  })
  return run
}
const calls = (run: ReturnType<typeof fakeGit>, what: string) =>
  run.mock.calls.filter(([args]) => args.join(" ").startsWith(what)).length

describe("PrLocal", () => {
  it("names each repo's default branch from its remote's HEAD, read once", async () => {
    const run = fakeGit({ "/w/r symbolic-ref --short refs/remotes/origin/HEAD": "origin/main\n" })
    const local = new PrLocal(run)
    const res = await local.checkouts({ roots: ["/w/r", "/w/l"] })
    expect(res.ok && res.repos.map((r) => r.defaultBranch)).toEqual(["main", undefined])
    await local.checkouts({ roots: ["/w/r"] })
    expect(calls(run, "symbolic-ref")).toBe(1) // cached with the remote; none asked for /w/l
  })

  it("no HEAD ref (or git failing): no default branch, asked again later", async () => {
    const run = fakeGit()
    const local = new PrLocal(run)
    const res = await local.checkouts({ roots: ["/w/r"] })
    expect(res.ok && res.repos[0]!.defaultBranch).toBeUndefined()
    await local.checkouts({ roots: ["/w/r"] })
    expect(calls(run, "symbolic-ref")).toBe(2)
  })

  it("one worktree list per repo, however many of its worktrees panes are in", async () => {
    const run = fakeGit()
    const res = await new PrLocal(run).checkouts({ roots: ["/w/r", "/w/r-wt", "/w/l"] })
    expect(res).toEqual({
      ok: true,
      repos: [
        {
          repo: "o/r",
          worktrees: [
            { path: "/w/r", branch: "main" },
            { path: "/w/r-wt", branch: "b1" },
          ],
        },
        { repo: null, worktrees: [{ path: "/w/l", branch: "x" }] },
      ],
    })
    expect(calls(run, "worktree list")).toBe(2)
  })

  it("asked again: the worktrees read again (a branch may have moved), the rest cached", async () => {
    const run = fakeGit()
    const local = new PrLocal(run)
    await local.checkouts({ roots: ["/w/r"] })
    await local.checkouts({ roots: ["/w/r"] })
    expect(calls(run, "worktree list")).toBe(2)
    expect(calls(run, "rev-parse")).toBe(1)
    expect(calls(run, "remote")).toBe(1)
  })

  it("the remote is looked up again after a minute", async () => {
    let t = 0
    const run = fakeGit()
    const local = new PrLocal(run, () => t)
    await local.checkouts({ roots: ["/w/r"] })
    t = 61_000
    await local.checkouts({ roots: ["/w/r"] })
    expect(calls(run, "remote")).toBe(2)
  })

  it("a root git can't read (gone, not a repo) is left out, asked again next time", async () => {
    const run = fakeGit({ "/w/r rev-parse --git-common-dir": new Error("not a repo") })
    const local = new PrLocal(run)
    expect(await local.checkouts({ roots: ["/w/r", "/w/l"] })).toMatchObject({
      ok: true,
      repos: [{ repo: null }],
    })
    await local.checkouts({ roots: ["/w/r"] })
    expect(calls(run, "rev-parse")).toBe(3) // (/w/r twice, /w/l once)
  })

  it("a failed remote lookup isn't kept: asked again next time", async () => {
    let fail = true
    const run = fakeGit()
    const inner = run.getMockImplementation()!
    run.mockImplementation(async (args, cwd) => {
      if (fail && args[0] === "remote") throw new Error("index.lock")
      return inner(args, cwd)
    })
    const local = new PrLocal(run)
    const first = await local.checkouts({ roots: ["/w/r"] })
    expect(first.ok && first.repos[0]!.repo).toBeNull()
    fail = false
    const second = await local.checkouts({ roots: ["/w/r"] })
    expect(second.ok && second.repos[0]!.repo).toBe("o/r")
  })

  it("a repo's first folder gone (a removed worktree): listed from its next one", async () => {
    const run = fakeGit({
      "/w/r-wt worktree list --porcelain": new Error("ENOENT"),
      "/w/r remote -v": "origin\tgit@github.com:o/r.git (fetch)\n",
    })
    const local = new PrLocal(run)
    const res = await local.checkouts({ roots: ["/w/r-wt", "/w/r"] })
    expect(res.ok && res.repos.map((r) => r.repo)).toEqual(["o/r"])
    // the gone one's repo is looked up again next time
    await local.checkouts({ roots: ["/w/r-wt", "/w/r"] })
    expect(run.mock.calls.filter(([a, c]) => a[0] === "rev-parse" && c === "/w/r-wt")).toHaveLength(
      2,
    )
  })

  it("a worktree whose folder is gone (a locked one on an unplugged drive): left out", async () => {
    const run = fakeGit()
    const local = new PrLocal(run, Date.now, async (p) => p !== "/w/r-wt")
    const res = await local.checkouts({ roots: ["/w/r"] })
    expect(res.ok && res.repos[0]!.worktrees.map((w) => w.path)).toEqual(["/w/r"])
  })

  it("a root its repo no longer lists (re-cloned as another repo): looked up again", async () => {
    // /w/x is cached as o/r's, but o/r's worktree list doesn't name it
    const run = fakeGit({ "/w/x rev-parse --git-common-dir": "/w/r/.git\n" })
    const local = new PrLocal(run)
    await local.checkouts({ roots: ["/w/r", "/w/x"] })
    await local.checkouts({ roots: ["/w/r", "/w/x"] })
    expect(run.mock.calls.filter(([a, c]) => a[0] === "rev-parse" && c === "/w/x")).toHaveLength(2)
    expect(run.mock.calls.filter(([a, c]) => a[0] === "rev-parse" && c === "/w/r")).toHaveLength(1)
  })

  it("a failed worktree list leaves that repo out; the others answer", async () => {
    const run = fakeGit({ "/w/l worktree list --porcelain": new Error("boom") })
    const res = await new PrLocal(run).checkouts({ roots: ["/w/r", "/w/l"] })
    expect(res.ok && res.repos.map((r) => r.repo)).toEqual(["o/r"])
  })

  it("only absolute roots, each once; the same request while it runs: one run", async () => {
    const run = fakeGit()
    const local = new PrLocal(run)
    const [a, b] = await Promise.all([
      local.checkouts({ roots: ["/w/r", "rel", "/w/r"] }),
      local.checkouts({ roots: ["/w/r"] }),
    ])
    expect(a).toEqual(b)
    expect(calls(run, "worktree list")).toBe(1)
    expect(run.mock.calls.some(([, cwd]) => cwd === "rel")).toBe(false)
  })
})

describe("PrLocal merged units", () => {
  const refs = [
    "refs/remotes/origin/main\0aaa",
    "refs/remotes/origin/b1\0bbb",
    "refs/remotes/origin/b2\0ccc",
    "refs/remotes/origin/HEAD\0aaa",
  ].join("\n")
  const pr = (head: string, base: string) => ({ repo: "O/R", head, base, defaultBranch: "main" })
  // git filters by the patterns asked for: the fake answers every ref of the remote asked
  const git = (over: Partial<Record<string, string | Error>> = {}) => {
    const run = fakeGit({
      "/w/r log --format=%ce%x00%s --max-count=501 aaa..bbb":
        "noreply@github.com\0a (#5)\nnoreply@github.com\0b (#6)\n",
      "/w/r log --format=%ce%x00%s --max-count=501 bbb..ccc ^aaa": "noreply@github.com\0c (#7)\n",
      ...over,
    })
    const inner = run.getMockImplementation()!
    run.mockImplementation(async (args, cwd) => {
      if (args[0] !== "for-each-ref") return inner(args, cwd)
      const remote = args[2]!.split("/")[2]!
      return remote === "origin" ? refs : refs.replaceAll("origin", remote)
    })
    return run
  }
  const key = (head: string, base: string) => `${head}\0${base}`

  it("from the remote's refs: the PR's own commits, not its base's nor the default branch's", async () => {
    const run = git()
    const res = await new PrLocal(run).checkouts({
      roots: ["/w/r"],
      prs: [pr("b1", "main"), pr("b2", "b1"), pr("gone", "main"), pr("x", "y")],
    })
    expect(res.ok && res.repos[0]!.merged).toEqual({
      [key("b1", "main")]: 2,
      [key("b2", "b1")]: 1,
    }) // (no refs: none)
    // only the refs asked about (and the remote's HEAD), never the whole remote
    const refsAsked = run.mock.calls.find(([a]) => a[0] === "for-each-ref")![0].slice(2)
    expect(refsAsked.sort()).toEqual(
      ["HEAD", "main", "b1", "b2", "gone", "x", "y"].map((n) => `refs/remotes/origin/${n}`).sort(),
    )
  })

  it("a PR whose tips didn't move isn't read again; one that moved is", async () => {
    let tips = refs
    const run = git()
    const inner = run.getMockImplementation()!
    run.mockImplementation(async (args, cwd) =>
      args[0] === "for-each-ref" ? tips : inner(args, cwd),
    )
    const local = new PrLocal(run)
    await local.checkouts({ roots: ["/w/r"], prs: [pr("b1", "main")] })
    await local.checkouts({ roots: ["/w/r"], prs: [pr("b1", "main")] })
    expect(calls(run, "log")).toBe(1)
    tips = refs.replace("b1\0bbb", "b1\0ddd")
    run.mockImplementation(async (args, cwd) =>
      args[0] === "for-each-ref"
        ? tips
        : args[0] === "log"
          ? "noreply@github.com\0a (#5)\n"
          : inner(args, cwd),
    )
    const res = await local.checkouts({ roots: ["/w/r"], prs: [pr("b1", "main")] })
    expect(calls(run, "log")).toBe(2) // (b1 moved: read once more)
    expect(res.ok && res.repos[0]!.merged).toEqual({ [key("b1", "main")]: 1 })
  })

  it("a range longer than 500 commits: no estimate", async () => {
    const long = Array.from({ length: 501 }, (_, i) => `noreply@github.com\0x (#${i})`).join("\n")
    const run = git({ "/w/r log --format=%ce%x00%s --max-count=501 aaa..bbb": long })
    const res = await new PrLocal(run).checkouts({ roots: ["/w/r"], prs: [pr("b1", "main")] })
    expect(res.ok && res.repos[0]!.merged).toEqual({})
  })

  it("the remote the repo is listed by (upstream first), and only that repo's PRs", async () => {
    const run = git({
      "/w/r remote -v":
        "origin\tgit@github.com:me/r.git (fetch)\nupstream\tgit@github.com:o/r.git (fetch)\n",
    })
    const res = await new PrLocal(run).checkouts({
      roots: ["/w/r"],
      prs: [pr("b1", "main"), { repo: "a/b", head: "b1", base: "main" }],
    })
    expect(res.ok && res.repos[0]!.merged).toEqual({ [key("b1", "main")]: 2 })
  })

  it("no PRs asked about (the list view): no refs read", async () => {
    const run = git()
    await new PrLocal(run).checkouts({ roots: ["/w/r"] })
    expect(calls(run, "for-each-ref")).toBe(0)
  })
})

describe("PrLocal merged units, more", () => {
  const refs =
    "refs/remotes/origin/HEAD\0aaa\nrefs/remotes/origin/main\0aaa\nrefs/remotes/origin/b1\0bbb\nrefs/remotes/origin/b2\0ccc"
  const withRefs = (run: ReturnType<typeof fakeGit>, log: (args: string[]) => Promise<string>) => {
    const inner = run.getMockImplementation()!
    run.mockImplementation(async (args, cwd) =>
      args[0] === "for-each-ref" ? refs : args[0] === "log" ? log(args) : inner(args, cwd),
    )
    return run
  }

  it("no default branch named (an older answer): the remote's HEAD is kept out", async () => {
    const run = withRefs(fakeGit(), async () => "noreply@github.com\0x (#1)\n")
    await new PrLocal(run).checkouts({
      roots: ["/w/r"],
      prs: [{ repo: "o/r", head: "b2", base: "b1" }],
    })
    const log = run.mock.calls.find(([a]) => a[0] === "log")![0]
    expect(log.slice(-2)).toEqual(["bbb..ccc", "^aaa"])
  })

  it("a range git failed on isn't run again for a while (a slow one would take a slot each refresh)", async () => {
    let t = 0
    const run = withRefs(fakeGit(), async () => {
      throw new Error("timeout")
    })
    const local = new PrLocal(run, () => t)
    const ask = () =>
      local.checkouts({ roots: ["/w/r"], prs: [{ repo: "o/r", head: "b1", base: "main" }] })
    await ask()
    await ask()
    expect(calls(run, "log")).toBe(1)
    t = 11 * 60_000
    await ask()
    expect(calls(run, "log")).toBe(2)
  })
})
