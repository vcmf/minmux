import { describe, it, expect } from "vitest"
import { PaneGitService, parseHeadInfo, parsePrView, type Runner } from "./pane-git"

describe("parseHeadInfo", () => {
  it("branch + repo root + git dir + place; a detached HEAD has no branch", () => {
    // git's output at the root: the prefix line is there, empty
    expect(parseHeadInfo("feat/x\n/repo\n/repo/.git\n\n")).toEqual({
      branch: "feat/x",
      root: "/repo",
      gitDir: "/repo/.git",
      prefix: "",
    })
    expect(parseHeadInfo("HEAD\r\n/repo\r\n/repo/.git\r\n\r\n")).toEqual({
      branch: null,
      root: "/repo",
      gitDir: "/repo/.git",
      prefix: "",
    })
    // --show-prefix: the folder's place in the repo (git resolves symlinks), trailing / dropped
    expect(parseHeadInfo("main\n/repo\n/repo/.git\nout/anim/\n")?.prefix).toBe("out/anim")
    // a worktree's git dir is its own (where its HEAD lives)
    expect(parseHeadInfo("b\n/wt\n/repo/.git/worktrees/wt\n\n")?.gitDir).toBe(
      "/repo/.git/worktrees/wt",
    )
    // no prefix line at all (with or without git's final newline): unknown, not the root
    expect(parseHeadInfo("main\n/repo\n")).toEqual({ branch: "main", root: "/repo" })
    expect(parseHeadInfo("main\n/repo")).toEqual({ branch: "main", root: "/repo" })
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

let ghRunning = 0 // gh calls in flight, across fakes (the PR lookups run in the background)

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
    ghRunning++
    try {
      if (opts.ghDelay) await new Promise((r) => setTimeout(r, opts.ghDelay))
      if (opts.ghMissing) throw Object.assign(new Error("gh missing"), { code: opts.ghMissing })
      const branch = opts.heads?.[cwd]?.split("\n")[0] ?? ""
      const pr = opts.prs?.[branch]
      if (!pr) throw new Error(`no pull requests found for branch "${branch}"`)
      return JSON.stringify(pr)
    } finally {
      ghRunning--
    }
  }
  return { run, calls, ghArgs, gh: () => calls.filter((c) => c.startsWith("gh")).length }
}

const PR51 = { number: 51, state: "MERGED", url: "https://x/pull/51", isDraft: false }
/** Let the background PR lookups finish: until no gh call runs (a few turns for the cache to
 *  settle), up to 3.5 s — not a guessed delay. */
const tick = async () => {
  const turn = () => new Promise((r) => setTimeout(r, 5))
  const deadline = Date.now() + 3500 // by the clock: a busy machine stretches each turn
  await turn()
  while (ghRunning > 0 && Date.now() < deadline) await turn()
  // Say so, rather than let the test run into its timeout (or assert on a half-done state).
  if (ghRunning > 0) throw new Error(`tick: ${ghRunning} gh call(s) still running after 3.5 s`)
  await turn()
}

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
    await tick() // its background gh mustn't run into the next test's wait
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
    let ghCalls = 0
    const run: Runner = async (cmd, _args, cwd) => {
      if (cmd === "git") return `b\n${cwd}`
      ghCalls++
      running++
      peak = Math.max(peak, running)
      await new Promise((r) => setTimeout(r, 5))
      running--
      throw new Error("no pull requests found")
    }
    const svc = new PaneGitService(run)
    await svc.lookup(Array.from({ length: 6 }, (_, i) => ({ paneId: `p${i}`, cwd: `/c${i}` })))
    // The PR lookups run in the background: wait until all six have run (not a guessed delay).
    const deadline = Date.now() + 3500
    while ((ghCalls < 6 || running > 0) && Date.now() < deadline)
      await new Promise((r) => setTimeout(r, 10))
    expect(ghCalls).toBe(6)
    expect(peak).toBe(2)
  })
})

describe("PaneGitService — cheap polls", () => {
  /** A fake git whose answers carry a git dir, counting launches; fake HEAD contents. */
  const setup = (head = "ref: refs/heads/main\n") => {
    let t = 0
    const heads = new Map<string, string>([["/r/.git/HEAD", head]])
    let gits = 0
    let running = 0
    let peak = 0
    let duringGit: (() => void) | undefined
    const run: Runner = async (cmd, _args, cwd) => {
      if (cmd === "gh") throw new Error("no pull requests found")
      gits++
      running++
      peak = Math.max(peak, running)
      duringGit?.()
      await new Promise((r) => setTimeout(r, 2))
      running--
      if (cwd.startsWith("/r")) return "main\n/r\n/r/.git\n\n"
      throw Object.assign(new Error("x"), { stderr: "fatal: not a git repository" })
    }
    const svc = new PaneGitService(
      run,
      () => t,
      async (p) => p,
      {
        read: async (p) => heads.get(p) ?? null,
        exists: async () => true,
      },
    )
    return {
      svc,
      advance: (ms: number) => (t += ms),
      heads,
      gits: () => gits,
      peak: () => peak,
      onGit: (fn: () => void) => (duringGit = fn),
    }
  }
  const ask = (svc: PaneGitService, cwd = "/r") => svc.lookup([{ paneId: "a", cwd, noPr: true }])

  it("an unchanged HEAD renews the answer without launching git", async () => {
    const f = setup()
    await ask(f.svc) // git: the answer + HEAD's contents as its stamp
    f.advance(10_000)
    expect((await ask(f.svc)).a?.branch).toBe("main")
    f.advance(10_000)
    await ask(f.svc)
    expect(f.gits()).toBe(1) // re-validated by HEAD's contents: no launch
  })

  it("a checkout (HEAD rewritten) relaunches git", async () => {
    const f = setup()
    await ask(f.svc)
    f.advance(10_000)
    f.heads.set("/r/.git/HEAD", "ref: refs/heads/feat\n")
    await ask(f.svc)
    expect(f.gits()).toBe(2)
  })

  it("a checkout landing while git runs is caught next time (HEAD read before git)", async () => {
    const f = setup()
    await ask(f.svc) // git #1
    f.advance(10_000)
    f.heads.set("/r/.git/HEAD", "ref: refs/heads/x\n") // a checkout → git #2, HEAD read first
    f.onGit(() => f.heads.set("/r/.git/HEAD", "ref: refs/heads/y\n")) // another, mid-launch
    await ask(f.svc)
    f.onGit(() => {})
    f.advance(10_000)
    await ask(f.svc) // the stamp is x (read before git), HEAD now says y → relaunch
    expect(f.gits()).toBe(3)
  })

  it("git re-checks at least every minute, whatever HEAD says", async () => {
    const f = setup()
    await ask(f.svc) // git at t=0
    for (let i = 0; i < 5; i++) {
      f.advance(10_000)
      await ask(f.svc) // renewed by the stamp (t=10…50 s)
    }
    expect(f.gits()).toBe(1)
    f.advance(10_000) // 60 s since git last ran
    await ask(f.svc)
    expect(f.gits()).toBe(2)
  })

  it("a reftable repo (HEAD is a fixed stub) never takes the shortcut", async () => {
    const f = setup("ref: refs/heads/.invalid\n")
    await ask(f.svc)
    f.advance(10_000)
    await ask(f.svc)
    f.advance(10_000)
    await ask(f.svc)
    expect(f.gits()).toBe(3)
  })

  it("a folder that isn't a repo is re-asked every 30 s, not every poll", async () => {
    const f = setup()
    await ask(f.svc, "/home")
    f.advance(10_000)
    await ask(f.svc, "/home")
    expect(f.gits()).toBe(1)
    f.advance(25_000)
    await ask(f.svc, "/home")
    expect(f.gits()).toBe(2)
  })

  it("at most 4 git launches at a time, exactly (a slot passes straight to the next)", async () => {
    const f = setup()
    await f.svc.lookup(
      Array.from({ length: 12 }, (_, i) => ({ paneId: `p${i}`, cwd: `/x${i}`, noPr: true })),
    )
    expect(f.gits()).toBe(12)
    expect(f.peak()).toBe(4)
  })
})

describe("PaneGitService — gh states", () => {
  const svcWith = (code: string | number, rootExists: boolean) => {
    let t = 0
    const run: Runner = async (cmd, _args, cwd) => {
      if (cmd === "git") return `main\n${cwd}`
      throw Object.assign(new Error("gh"), { code })
    }
    const svc = new PaneGitService(
      run,
      () => t,
      async (p) => p,
      {
        read: async () => null,
        exists: async () => rootExists,
      },
    )
    return { svc, advance: (ms: number) => (t += ms) }
  }

  it("not logged in (exit 4): answers say so (a hint on hover)", async () => {
    const { svc } = svcWith(4, true)
    await svc.lookup([{ paneId: "a", cwd: "/r" }])
    await tick()
    expect((await svc.lookup([{ paneId: "a", cwd: "/r" }])).a?.gh).toBe("unauthenticated")
  })

  it("after logging in, a branch without a PR (exit 1) clears the 'log in' hint", async () => {
    let code: number = 4
    let t = 0
    const run: Runner = async (cmd, _args, cwd) => {
      if (cmd === "git") return `main\n${cwd}`
      throw Object.assign(new Error("gh"), { code })
    }
    const svc = new PaneGitService(
      run,
      () => t,
      async (p) => p,
      {
        read: async () => null,
        exists: async () => true,
      },
    )
    await svc.lookup([{ paneId: "a", cwd: "/r" }])
    await tick()
    code = 1 // logged in now; this branch just has no PR
    t += 3 * 60_000 // past the "no PR" TTL
    await svc.lookup([{ paneId: "a", cwd: "/r" }])
    await tick()
    expect((await svc.lookup([{ paneId: "a", cwd: "/r" }])).a?.gh).toBeUndefined()
  })

  it("gh missing (ENOENT with the folder there): answers say so", async () => {
    const { svc } = svcWith("ENOENT", true)
    await svc.lookup([{ paneId: "a", cwd: "/r" }])
    await tick()
    expect((await svc.lookup([{ paneId: "b", cwd: "/s" }])).b?.gh).toBe("missing")
  })

  it("ENOENT because the folder is gone (a removed worktree) doesn't switch PRs off", async () => {
    const { svc } = svcWith("ENOENT", false)
    await svc.lookup([{ paneId: "a", cwd: "/gone" }])
    await tick()
    expect((await svc.lookup([{ paneId: "b", cwd: "/s" }])).b?.gh).toBeUndefined()
  })
})
