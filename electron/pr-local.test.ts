import { describe, it, expect, vi } from "vitest"
import { PrLocal, type GitRunner } from "./pr-local"

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
