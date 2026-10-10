import { describe, it, expect } from "vitest"
import { PaneGitService, parseHeadInfo, parsePrView, type Runner } from "./pane-git"

describe("parseHeadInfo", () => {
  it("branch + repo root; a detached HEAD has no branch", () => {
    expect(parseHeadInfo("feat/x\n/repo\n")).toEqual({
      branch: "feat/x",
      root: "/repo",
      prefix: "",
    })
    expect(parseHeadInfo("HEAD\r\n/repo\r\n")).toEqual({ branch: null, root: "/repo", prefix: "" })
    // --show-prefix: the folder's place in the repo (git resolves symlinks), trailing / dropped
    expect(parseHeadInfo("main\n/repo\nout/anim/\n")?.prefix).toBe("out/anim")
    expect(parseHeadInfo("main\n/repo")).toEqual({ branch: "main", root: "/repo" }) // unknown, not ""
    expect(parseHeadInfo("")).toBeNull()
  })
})

describe("parsePrView", () => {
  const pr = (o: object) => JSON.stringify({ number: 51, url: "https://x/pull/51", ...o })
  it("maps gh states (draft = an open PR marked draft)", () => {
    expect(parsePrView(pr({ state: "MERGED" }))?.state).toBe("merged")
    expect(parsePrView(pr({ state: "CLOSED" }))?.state).toBe("closed")
    expect(parsePrView(pr({ state: "OPEN", isDraft: true }))?.state).toBe("draft")
    expect(parsePrView(pr({ state: "OPEN", isDraft: false }))).toEqual({
      number: 51,
      state: "open",
      url: "https://x/pull/51",
    })
  })
  it("junk → null", () => {
    expect(parsePrView("no pull requests found")).toBeNull()
    expect(parsePrView(JSON.stringify({ state: "OPEN" }))).toBeNull()
  })
})

/** A fake runner: git answers per cwd, gh per checked-out branch (of that cwd); counts calls. */
function fake(opts: {
  heads?: Record<string, string> // cwd → rev-parse output (absent = not a repo)
  prs?: Record<string, object> // branch → gh json (absent = "no PR" failure)
  ghMissing?: "ENOENT" | 127
  ghDelay?: number
}) {
  const calls: string[] = []
  const ghArgs: string[][] = []
  const run: Runner = async (cmd, args, cwd, wsl) => {
    calls.push(`${cmd} ${wsl ? `wsl:${wsl.distro}:` : ""}${cwd}`)
    if (cmd === "git") {
      const h = opts.heads?.[cwd]
      if (!h) throw new Error("not a git repository")
      return h
    }
    ghArgs.push(args)
    if (opts.ghDelay) await new Promise((r) => setTimeout(r, opts.ghDelay))
    if (opts.ghMissing) throw Object.assign(new Error("gh missing"), { code: opts.ghMissing })
    const branch = opts.heads?.[cwd]?.split("\n")[0] ?? ""
    const pr = opts.prs?.[branch]
    if (!pr) throw new Error(`no pull requests found for branch "${branch}"`)
    return JSON.stringify(pr)
  }
  return { run, calls, ghArgs, gh: () => calls.filter((c) => c.startsWith("gh")).length }
}

const PR51 = { number: 51, state: "MERGED", url: "https://x/pull/51", isDraft: false }
const tick = () => new Promise((r) => setTimeout(r, 15))

describe("PaneGitService", () => {
  it("noPr: branch + root only, no gh call (collapsed sidebar)", async () => {
    const f = fake({ heads: { "/r": "main\n/r" }, prs: { main: PR51 } })
    const svc = new PaneGitService(f.run, Date.now, async (p) => p)
    expect(await svc.lookup([{ paneId: "a", cwd: "/r", noPr: true }])).toEqual({
      a: { branch: "main", root: "/r", real: "/r" }, // the fake prints no prefix line
    })
    await tick()
    expect(f.gh()).toBe(0)
  })

  it("resolves symlinks for the real path (host only, cached; WSL paths aren't resolvable)", async () => {
    const f = fake({})
    let calls = 0
    const svc = new PaneGitService(f.run, Date.now, async (p) => (calls++, `/private${p}`))
    expect(await svc.lookup([{ paneId: "a", cwd: "/tmp/x" }])).toEqual({
      a: { real: "/private/tmp/x" },
    })
    await svc.lookup([{ paneId: "a", cwd: "/tmp/x" }])
    expect(calls).toBe(1)
    expect(await svc.lookup([{ paneId: "w", cwd: "/home/u", wsl: { distro: "D" } }])).toEqual({
      w: {},
    })
  })

  it("branch now, PR fetched in the background (prPending), then served from cache", async () => {
    const f = fake({ heads: { "/repo": "feat/x\n/repo" }, prs: { "feat/x": PR51 } })
    const svc = new PaneGitService(f.run, Date.now, async (p) => p)
    const req = [
      { paneId: "a", cwd: "/repo" },
      { paneId: "b", cwd: "/tmp" }, // not a repo → only its real path
    ]
    expect(await svc.lookup(req)).toEqual({
      a: { branch: "feat/x", root: "/repo", real: "/repo", prPending: true },
      b: { real: "/tmp" },
    })
    await tick()
    expect(await svc.lookup(req)).toEqual({
      b: { real: "/tmp" },
      a: {
        branch: "feat/x",
        root: "/repo",
        real: "/repo",
        pr: { number: 51, state: "merged", url: "https://x/pull/51" },
      },
    })
  })

  it("never waits on gh: the branch comes back while gh is still running", async () => {
    const f = fake({ heads: { "/r": "x\n/r" }, prs: { x: PR51 }, ghDelay: 1000 })
    const svc = new PaneGitService(f.run)
    const t0 = Date.now()
    expect(await svc.lookup([{ paneId: "a", cwd: "/r" }])).toMatchObject({ a: { branch: "x" } })
    expect(Date.now() - t0).toBeLessThan(500)
  })

  it("asks gh for the CHECKED-OUT branch's PR (no name arg — a fork's same-named PR can't match)", async () => {
    const f = fake({ heads: { "/r": "main\n/r" } })
    await new PaneGitService(f.run).lookup([{ paneId: "a", cwd: "/r" }])
    await tick()
    expect(f.ghArgs[0]).toEqual(["pr", "view", "--json", "number,state,url,isDraft"])
  })

  it("a branch without a PR shows just the branch; detached HEAD skips gh", async () => {
    const f = fake({ heads: { "/r": "main\n/r", "/d": "HEAD\n/d" } })
    const svc = new PaneGitService(f.run)
    const req = [
      { paneId: "a", cwd: "/r" },
      { paneId: "b", cwd: "/d" },
    ]
    await svc.lookup(req)
    await tick()
    expect(await svc.lookup(req)).toEqual({
      a: { branch: "main", root: "/r" },
      b: { root: "/d" },
    })
    expect(f.gh()).toBe(1) // only for "main"
  })

  it("panes sharing a repo+branch share one gh call", async () => {
    const f = fake({ heads: { "/r": "feat/x\n/r" }, prs: { "feat/x": PR51 } })
    const svc = new PaneGitService(f.run)
    await svc.lookup([
      { paneId: "a", cwd: "/r" },
      { paneId: "b", cwd: "/r" },
    ])
    await tick()
    await svc.lookup([{ paneId: "a", cwd: "/r" }])
    expect(f.gh()).toBe(1)
  })

  it("an open PR is re-checked after a minute (stale value shown meanwhile); merged much later", async () => {
    let t = 0
    const open = { ...PR51, state: "OPEN" }
    const f = fake({ heads: { "/o": "o\n/o", "/m": "m\n/m" }, prs: { o: open, m: PR51 } })
    const svc = new PaneGitService(f.run, () => t)
    const both = [
      { paneId: "a", cwd: "/o" },
      { paneId: "b", cwd: "/m" },
    ]
    await svc.lookup(both)
    await tick()
    t += 61_000
    const stale = await svc.lookup(both)
    expect(stale.a).toMatchObject({ pr: { state: "open" }, prPending: true }) // stale, refreshing
    expect(stale.b?.prPending).toBeUndefined()
    await tick()
    expect(f.calls.filter((c) => c === "gh /o")).toHaveLength(2)
    expect(f.calls.filter((c) => c === "gh /m")).toHaveLength(1)
  })

  it("gh not installed (ENOENT, or exit 127 inside WSL) → backs off in THAT environment only", async () => {
    let t = 0
    const f = fake({ heads: { "/r": "a\n/r", "/s": "b\n/s" }, ghMissing: 127 })
    const svc = new PaneGitService(f.run, () => t)
    const wsl = { distro: "Ubuntu" }
    await svc.lookup([{ paneId: "x", cwd: "/r", wsl }])
    await tick()
    await svc.lookup([{ paneId: "y", cwd: "/s", wsl }]) // same distro, other branch → skipped
    await tick()
    expect(f.gh()).toBe(1)
    await svc.lookup([{ paneId: "z", cwd: "/s" }]) // host is a different environment
    await tick()
    expect(f.gh()).toBe(2)
    t += 11 * 60_000
    await svc.lookup([{ paneId: "w", cwd: "/r", wsl }])
    await tick()
    expect(f.gh()).toBe(3)
  })

  it("runs at most 2 gh processes at once", async () => {
    let running = 0
    let peak = 0
    const run: Runner = async (cmd, _args, cwd) => {
      if (cmd === "git") return `b\n${cwd}`
      running++
      peak = Math.max(peak, running)
      await new Promise((r) => setTimeout(r, 5))
      running--
      throw new Error("no pull requests found")
    }
    const svc = new PaneGitService(run)
    await svc.lookup(Array.from({ length: 6 }, (_, i) => ({ paneId: `p${i}`, cwd: `/c${i}` })))
    await new Promise((r) => setTimeout(r, 60))
    expect(peak).toBe(2)
  })
})
