import { describe, it, expect } from "vitest"
import { reduceAgentEvents, agentPanes, type AgentEvent } from "./agent-graph"
import {
  agentWorkDirs,
  agentWorkFlat,
  inLabel,
  workCwd,
  worksElsewhere,
  isInside,
  inGitFor,
  planGitPoll,
  settleInAnswers,
  keepPrs,
  samePath,
  inGitKey,
  paneOfGitKey,
} from "./agent-dirs"

const graph = (events: AgentEvent[]) => reduceAgentEvents(events)

describe("agentWorkDirs", () => {
  it("follows the session's cwd: SessionStart, then CwdChanged (entering a worktree)", () => {
    const g = graph([
      { event: "SessionStart", sessionId: "s", paneId: "p", cwd: "/r" },
      { event: "CwdChanged", sessionId: "s", paneId: "p", cwd: "/r/.claude/worktrees/a" },
    ])
    expect(agentWorkDirs(g).p?.cwd).toBe("/r/.claude/worktrees/a")
  })

  it("other worktrees exclude the one Claude is in; the newest session of a pane wins", () => {
    const g = graph([
      { event: "SessionStart", sessionId: "old", paneId: "p", cwd: "/old" },
      { event: "SessionStart", sessionId: "s", paneId: "p", cwd: "/r", source: "resume" }, // /resume
      { event: "WorktreeCreate", sessionId: "s", paneId: "p", worktreePath: "/r/wt/a" },
      { event: "WorktreeCreate", sessionId: "s", paneId: "p", worktreePath: "/r/wt/b" },
      { event: "CwdChanged", sessionId: "s", paneId: "p", cwd: "/r/wt/a/" },
    ])
    const d = agentWorkDirs(g).p
    expect(d?.cwd).toBe("/r/wt/a/")
    expect(d?.others.map((w) => w.path)).toEqual(["/r/wt/b"])
  })

  it("no entry without a pane or a known cwd; memoized per graph", () => {
    const g = graph([
      { event: "SessionStart", sessionId: "a" }, // outside minmux's panes
      { event: "Stop", sessionId: "b", paneId: "p" }, // root without a cwd yet
    ])
    expect(agentWorkDirs(g)).toEqual({})
    expect(agentWorkDirs(g)).toBe(agentWorkDirs(g))
  })

  it("workCwd: Claude's folder while it works in another checkout, else the shell's", () => {
    const g = graph([{ event: "SessionStart", sessionId: "s", paneId: "p", cwd: "/r/wt" }])
    const git = { p: { root: "/r" }, "p@in": { root: "/r/wt", forCwd: "/r/wt" } }
    expect(workCwd(g, git, "p", "/r")).toBe("/r/wt")
    const same = { p: { root: "/r" }, "p@in": { root: "/r", forCwd: "/r/wt" } }
    expect(workCwd(g, same, "p", "/r")).toBe("/r")
    expect(workCwd(g, {}, "other", "/x")).toBe("/x")
  })

  it("a newest session with no folder yet hides the pane's older folder", () => {
    const g = graph([
      { event: "SessionStart", sessionId: "a", paneId: "p", cwd: "/a" },
      { event: "SessionStart", sessionId: "b", paneId: "p", source: "clear" },
    ])
    expect(agentWorkDirs(g).p).toBeUndefined()
  })

  it("an older session restarting in the same pane (/resume back) is the live one again", () => {
    const g = graph([
      { event: "SessionStart", sessionId: "a", paneId: "p", cwd: "/a" },
      { event: "SessionStart", sessionId: "b", paneId: "p", cwd: "/b", source: "resume" },
      { event: "SessionStart", sessionId: "a", paneId: "p", cwd: "/a", source: "resume" },
    ])
    expect(agentWorkDirs(g).p?.cwd).toBe("/a")
  })

  it("the newest-started session of a pane wins, even one resumed from another pane", () => {
    const g = graph([
      { event: "SessionStart", sessionId: "a", paneId: "p", cwd: "/a" },
      { event: "SessionStart", sessionId: "b", paneId: "q", cwd: "/b" },
      { event: "SessionStart", sessionId: "a", paneId: "q", cwd: "/a2", source: "resume" }, // in q
    ])
    expect(agentWorkDirs(g).q?.cwd).toBe("/a2")
    expect(agentWorkFlat(g)).toBe(agentWorkFlat(g))
    expect(agentWorkFlat(g)).toEqual(["q", "claude", "/a2", ""])
  })
})

describe("inGitFor / workCwd follow the checkout, not Claude's subfolder", () => {
  it("an answer stays valid while Claude moves inside that repo (no flicker on `cd src`)", () => {
    const ans = { root: "/r/wt", forCwd: "/r/wt" }
    expect(inGitFor(ans, "/r/wt/src", "claude")).toBe(ans)
    expect(inGitFor(ans, "/elsewhere", "claude")).toBeUndefined()
    expect(inGitFor({ real: "/x", forCwd: "/x" }, "/x/sub", "claude")).toBeUndefined() // no repo: exact only
    // …but a worktree nested in the repo (EnterWorktree) is a new checkout: wait for its answer
    expect(
      inGitFor({ root: "/p", forCwd: "/p" }, "/p/.claude/worktrees/f", "claude"),
    ).toBeUndefined()
    // …only for the agent that lays worktrees out that way: Codex inside such a folder is in /p
    const repo = { root: "/p", forCwd: "/p" }
    expect(inGitFor(repo, "/p/.claude/worktrees/f", "codex")).toBe(repo)
    // git on Windows answers C:/…, the shell says C:\…
    const win = { root: "C:/u/wt", forCwd: "C:\\u\\wt" }
    expect(inGitFor(win, "C:\\u\\wt\\src", "claude")).toBe(win)
  })
  it("git views follow the checkout root while Claude is in a subfolder of it", () => {
    const g = graph([{ event: "SessionStart", sessionId: "s", paneId: "p", cwd: "/r/wt/src" }])
    const git = { p: { root: "/r" }, "p@in": { root: "/r/wt", forCwd: "/r/wt" } }
    expect(workCwd(g, git, "p", "/r")).toBe("/r/wt")
  })
})

describe("worksElsewhere", () => {
  const at = (cwd: string, o: object = {}) => ({ forCwd: cwd, ...o }) // an `in` lookup for cwd
  it("undecided (false) until Claude's folder is looked up — no flicker, stale answers ignored", () => {
    expect(worksElsewhere("/r", "/api", { root: "/r" }, undefined, "claude")).toBe(false)
    expect(
      worksElsewhere("/r", "/api", { root: "/r" }, at("/old", { root: "/old" }), "claude"),
    ).toBe(false)
    expect(worksElsewhere(undefined, "/r", undefined, at("/r"), "claude")).toBe(false)
  })
  it("by repo root: symlinks and a `cd src` are the same checkout, a worktree isn't", () => {
    const P = "/private/tmp/p"
    expect(worksElsewhere("/tmp/p", P, { root: P }, at(P, { root: P }), "claude")).toBe(false)
    expect(
      worksElsewhere("/r", "/r/src", { root: "/r" }, at("/r/src", { root: "/r" }), "claude"),
    ).toBe(false)
    const wt = "/r/.claude/worktrees/a"
    expect(worksElsewhere("/r", wt, { root: "/r" }, at(wt, { root: wt }), "claude")).toBe(true)
  })
  it("a repo the shell isn't in (shell outside git, Claude cd'd into a repo below)", () => {
    expect(
      worksElsewhere("/w", "/w/term", undefined, at("/w/term", { root: "/w/term" }), "claude"),
    ).toBe(true)
  })
  it("outside git: by real path — symlinked spellings and subfolders are the same place", () => {
    const shell = { real: "/private/tmp/x" }
    expect(
      worksElsewhere(
        "/tmp/x",
        "/private/tmp/x",
        shell,
        at("/private/tmp/x", { real: "/private/tmp/x" }),
        "claude",
      ),
    ).toBe(false)
    expect(
      worksElsewhere(
        "/tmp/x",
        "/private/tmp/x/sub",
        shell,
        at("/private/tmp/x/sub", { real: "/private/tmp/x/sub" }),
        "claude",
      ),
    ).toBe(false)
    expect(worksElsewhere("/tmp/x", "/api", shell, at("/api", { real: "/api" }), "claude")).toBe(
      true,
    )
    expect(worksElsewhere("/", "/Users/me", undefined, at("/Users/me"), "claude")).toBe(false) // shell at /
  })
})

describe("inLabel", () => {
  const home = "/Users/me"
  it("relative inside `from`; ~-shortened elsewhere (another repo)", () => {
    expect(inLabel("/Users/me/term", "/Users/me/term/.claude/worktrees/x", home)).toBe(
      ".claude/worktrees/x",
    )
    expect(inLabel("/Users/me/term", "/Users/me/term-api", home)).toBe("~/term-api") // not a child
    expect(inLabel("C:\\r", "C:\\r\\wt", home)).toBe("wt")
    // shell on the logical /tmp path, Claude on the physical one: relative to the repo root
    expect(inLabel("/tmp/r", "/private/tmp/r/wt/a", home, "/private/tmp/r")).toBe("wt/a")
    expect(inLabel("/", "/Users/me/p", home)).toBe("Users/me/p")
  })
})

describe("helpers", () => {
  it("samePath ignores a trailing slash; git keys round-trip", () => {
    expect(samePath("/a/", "/a")).toBe(true)
    expect(samePath("/", "/")).toBe(true)
    expect(isInside("/a/b", "/a")).toBe(true)
    expect(isInside("/ab", "/a")).toBe(false)
    expect(isInside("/a", "/a/")).toBe(false)
    expect(isInside("C:\\x", "C:\\")).toBe(true)
    expect(paneOfGitKey(inGitKey("p1"))).toBe("p1")
    expect(paneOfGitKey("p1")).toBe("p1")
  })
})

describe("planGitPoll / settleInAnswers", () => {
  const sh = (id: string, cwd?: string) => ({ id, cwd, command: "/bin/zsh", args: [] })
  const work = {
    b: { agent: "claude" as const, cwd: "/b/wt", others: [] },
    c: { agent: "claude" as const, cwd: "/c", others: [] },
  }

  it("shell folder per terminal + Claude's when it moved; clears `in` where it didn't", () => {
    const p = planGitPoll([sh("a", "/a"), sh("b", "/b"), sh("c", "/c"), sh("d")], work, false)
    expect(p.reqs.map((r) => `${r.paneId}:${r.cwd}`)).toEqual([
      "a:/a",
      "b:/b",
      "b@in:/b/wt",
      "c:/c",
    ])
    expect(p.polled).toEqual(["a@in", "a", "b", "c@in", "c"])
    expect(p.reqs.every((r) => !r.noPr)).toBe(true)
    expect(p.inCwd).toEqual({ "b@in": "/b/wt" })
  })

  it("sidebar collapsed: only terminals whose Claude moved", () => {
    const p = planGitPoll([sh("a", "/a"), sh("b", "/b")], work, true)
    expect(p.reqs.map((r) => r.paneId)).toEqual(["b", "b@in"])
    expect(p.reqs.every((r) => r.noPr)).toBe(true) // no gh calls: no PR is on screen
    expect(p.polled).toContain("a@in") // a stale `in` of an unmoved terminal still clears
  })

  it("the 64 cap skips a pair that doesn't fit but still fills with single terminals", () => {
    const many = Array.from({ length: 63 }, (_, i) => sh(`s${i}`, `/s${i}`))
    const p = planGitPoll([...many, sh("b", "/b"), sh("z", "/z")], work, false)
    expect(p.reqs).toHaveLength(64)
    expect(p.reqs[63]?.paneId).toBe("z")
  })

  it("tags answers with their folder; losing the repo for the same folder is kept once", () => {
    type R = Record<string, { root?: string; real?: string; forCwd?: string; kept?: boolean }>
    const prev = { root: "/b/wt", forCwd: "/b/wt" }
    const res: R = { "b@in": { real: "/b/wt" } } // git timed out; realpath still worked
    settleInAnswers(res, { "b@in": "/b/wt" }, { "b@in": prev })
    expect(res["b@in"]).toEqual({ ...prev, kept: true })
    const again: R = { "b@in": { real: "/b/wt" } } // still no repo: it really left git → accept
    settleInAnswers(again, { "b@in": "/b/wt" }, { "b@in": { ...prev, kept: true } })
    expect(again["b@in"]).toEqual({ real: "/b/wt", forCwd: "/b/wt" })
    const steady: R = { "b@in": { real: "/b/wt" } } // …and stays accepted (no flip-flop)
    settleInAnswers(steady, { "b@in": "/b/wt" }, { "b@in": again["b@in"]! })
    expect(steady["b@in"]?.kept).toBeUndefined()
  })

  it("keepPrs: a no-PR answer keeps the known PR of the same branch", () => {
    const pr = { number: 5, state: "open" as const, url: "u" }
    const res = { a: { branch: "x" }, b: { branch: "y" } }
    keepPrs(res, { a: { branch: "x", pr }, b: { branch: "z", pr } })
    expect(res).toEqual({ a: { branch: "x", pr }, b: { branch: "y" } })
  })
})

describe("background agents don't take the pane over (main tags them nested)", () => {
  it("a session tagged nested never becomes the pane's `in`, even started later or re-started", () => {
    const g = graph([
      { event: "SessionStart", sessionId: "lead", paneId: "p", cwd: "/dimo", nested: false },
      { event: "SessionStart", sessionId: "agent", paneId: "p", cwd: "/dimo", nested: true },
      { event: "CwdChanged", sessionId: "agent", paneId: "p", cwd: "/tmp/pad", nested: true },
      {
        event: "SessionStart",
        sessionId: "agent",
        paneId: "p",
        cwd: "/tmp/pad",
        source: "compact",
        nested: true,
      },
    ])
    expect(agentWorkDirs(g).p?.cwd).toBe("/dimo")
  })

  it("after a renderer reload the agent may be seen first — the lead still wins", () => {
    const g = graph([
      { event: "PreToolUse", sessionId: "agent", paneId: "p", cwd: "/tmp/pad", nested: true },
      { event: "PreToolUse", sessionId: "lead", paneId: "p", cwd: "/dimo", nested: false },
    ])
    expect(agentWorkDirs(g).p?.cwd).toBe("/dimo")
  })

  it("when the lead is replaced (/clear → new lead), the tag follows", () => {
    const g = graph([
      { event: "SessionStart", sessionId: "old", paneId: "p", cwd: "/a", nested: false },
      { event: "SessionEnd", sessionId: "old", paneId: "p" },
      {
        event: "SessionStart",
        sessionId: "new",
        paneId: "p",
        cwd: "/b",
        source: "clear",
        nested: false,
      },
    ])
    expect(agentWorkDirs(g).p?.cwd).toBe("/b")
  })
})

describe("a background agent alone in a pane isn't the pane's Claude", () => {
  it("after the lead ends, no `in` and no Claude icon from the agent", () => {
    const g = graph([
      { event: "SessionStart", sessionId: "lead", paneId: "p", cwd: "/dimo", nested: false },
      { event: "SessionStart", sessionId: "agent", paneId: "p", cwd: "/tmp/pad", nested: true },
      { event: "SessionEnd", sessionId: "lead", paneId: "p" },
    ])
    expect(agentWorkDirs(g).p).toBeUndefined()
    expect(agentPanes(g)).toEqual([])
  })
})

describe("a stray SessionStart main rejected doesn't move the lead", () => {
  it("main drops a rejected folder (cwd undefined): the graph keeps the lead's folder", () => {
    const g = graph([
      { event: "SessionStart", sessionId: "lead", paneId: "p", cwd: "/dimo", nested: false },
      { event: "SessionStart", sessionId: "lead", paneId: "p", source: "resume", nested: false },
    ])
    expect(agentWorkDirs(g).p?.cwd).toBe("/dimo")
  })
})
