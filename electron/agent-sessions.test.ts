import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { SessionLedger } from "./agent-sessions"
import { claudeSessionRules, resumeCommand } from "./agents/claude"
import { claudeProjectDirName } from "../src/lib/claude-project"
import type { AgentEvent } from "../src/lib/agent-graph"

const ID = "7fe87f63-8ccf-437e-b991-94aa4ee44a0e"
const ID2 = "0b0e2a3c-1111-4222-8333-944455556666"
const start = (o: Partial<AgentEvent> = {}): AgentEvent => ({
  event: "SessionStart",
  sessionId: ID,
  paneId: "p1",
  cwd: "/repo",
  transcriptPath: "/t/a.jsonl",
  source: "startup",
  permissionMode: "default",
  ...o,
})
const end = (o: Partial<AgentEvent> = {}): AgentEvent => ({
  event: "SessionEnd",
  sessionId: ID,
  paneId: "p1",
  reason: "other",
  ...o,
})
type Preflight = () => Promise<{ skip?: string; unverified?: boolean }>
const yes: Preflight = async () => ({})
const plan = (
  l: SessionLedger,
  ids = ["p1"],
  live = () => false,
  preflight: Preflight = yes,
  bypass = false,
) => l.plan(ids, live, preflight, bypass)

describe("resumeCommand", () => {
  const e = { sessionId: ID, cwd: "/r", updatedAt: 0 }
  it("resume by id; keeps a non-default permission mode", () => {
    expect(resumeCommand(e, false)).toBe(`claude --resume ${ID}`)
    expect(resumeCommand({ ...e, permissionMode: "acceptEdits" }, false)).toBe(
      `claude --resume ${ID} --permission-mode acceptEdits`,
    )
    expect(resumeCommand({ ...e, permissionMode: "default" }, false)).toBe(`claude --resume ${ID}`)
  })
  it("bypassPermissions only when explicitly allowed", () => {
    const b = { ...e, permissionMode: "bypassPermissions" }
    expect(resumeCommand(b, false)).toBe(`claude --resume ${ID}`)
    expect(resumeCommand(b, true)).toBe(`claude --resume ${ID} --permission-mode bypassPermissions`)
  })
  it("never builds a command from an untrusted id or mode (it's typed into a shell)", () => {
    expect(resumeCommand({ ...e, sessionId: "x; rm -rf ~" }, false)).toBeNull()
    expect(resumeCommand({ ...e, permissionMode: "plan; ls" }, false)).toBe(`claude --resume ${ID}`)
  })
})

describe("SessionLedger rules", () => {
  it("SessionStart records the pane's session; /clear, /compact (new start) replace it", () => {
    const l = new SessionLedger(null)
    l.apply(start())
    expect(l.get("p1")).toMatchObject({ sessionId: ID, cwd: "/repo" })
    l.apply(end({ reason: "clear" })) // Claude ends the old session first
    l.apply(start({ sessionId: ID2, source: "clear" }))
    expect(l.get("p1")?.sessionId).toBe(ID2)
  })

  it("a nested `startup` while the pane's session is live (claude -p from a tool) is ignored", () => {
    const l = new SessionLedger(null)
    l.apply(start())
    l.apply(start({ sessionId: ID2, source: "startup" })) // child claude inherits the pane id
    l.apply(end({ sessionId: ID2 })) // …and its end must not delete the parent either
    expect(l.get("p1")?.sessionId).toBe(ID)
  })

  it("ANY SessionEnd of the tracked session clears it (/exit, double Ctrl-C = 'other', logout)", () => {
    for (const reason of ["prompt_input_exit", "other", "logout"]) {
      const l = new SessionLedger(null)
      l.apply(start())
      l.apply(end({ reason }))
      expect(l.get("p1"), reason).toBeUndefined()
    }
  })

  it("the shell prompt returning (Claude exited, SessionEnd or not) clears it — unless quitting", () => {
    const l = new SessionLedger(null)
    l.apply(start())
    l.shellIdle("p1")
    expect(l.get("p1")).toBeUndefined()
    l.apply(start())
    l.freeze()
    l.shellIdle("p1")
    expect(l.get("p1")?.sessionId).toBe(ID)
  })

  it("later events refresh the permission mode (Shift-Tab mid-session)", () => {
    const l = new SessionLedger(null)
    l.apply(start())
    l.apply({ event: "PreToolUse", sessionId: ID, paneId: "p1", permissionMode: "plan" })
    expect(l.get("p1")?.permissionMode).toBe("plan")
  })

  it("stores the pane's WSL distro; ignores sub-agent and pane-less events", () => {
    const l = new SessionLedger(null)
    l.apply(start({ agentId: "a1" }))
    l.apply(start({ paneId: undefined }))
    expect(l.get("p1")).toBeUndefined()
    l.apply(start(), "Debian")
    expect(l.get("p1")?.wslDistro).toBe("Debian")
  })

  it("freeze (quit / OS shutdown) keeps entries through the SessionEnds our kill triggers", () => {
    const l = new SessionLedger(null)
    l.apply(start())
    l.freeze()
    l.apply(end())
    l.drop("p1") // PTY exit during the quit
    expect(l.get("p1")?.sessionId).toBe(ID)
  })

  it("closing the pane (not quitting) drops it", () => {
    const l = new SessionLedger(null)
    l.apply(start())
    l.drop("p1")
    expect(l.get("p1")).toBeUndefined()
  })
})

describe("SessionLedger — round-2 rules", () => {
  let dir: string
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "minmux-ledger2-"))
  })
  afterEach(() => {
    vi.useRealTimers()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it("an entry carried over from the previous run is replaced by any new session", () => {
    const file = path.join(dir, "l.json")
    const a = new SessionLedger(file)
    a.apply(start())
    a.freeze()
    const b = new SessionLedger(file) // relaunch: the entry is 'carried'
    b.apply(start({ sessionId: ID2, source: "startup" })) // user typed a fresh `claude`
    expect(b.get("p1")?.sessionId).toBe(ID2)
    // …and once recorded this run, the nested-claude guard applies again
    b.apply(start({ sessionId: ID, source: "startup" }))
    expect(b.get("p1")?.sessionId).toBe(ID2)
  })

  it("a freeze from an OS shutdown thaws if we're still running (shutdown cancelled)", () => {
    vi.useFakeTimers()
    const l = new SessionLedger(null)
    l.apply(start())
    l.freeze(60_000)
    l.apply(end())
    expect(l.get("p1")).toBeDefined() // frozen
    vi.advanceTimersByTime(61_000)
    // thawed entries are treated as carried: a new session replaces a possibly-stale one
    l.apply(start({ sessionId: ID2, source: "startup" }))
    expect(l.get("p1")?.sessionId).toBe(ID2)
    l.apply(end({ sessionId: ID2 }))
    expect(l.get("p1")).toBeUndefined() // tracking again
  })

  it("the 'carried' flag is never written to disk", () => {
    const file = path.join(dir, "l.json")
    const a = new SessionLedger(file)
    a.apply(start())
    a.flushSync()
    const b = new SessionLedger(file)
    b.flushSync()
    expect(fs.readFileSync(file, "utf8")).not.toContain("carried")
  })

  it("debounced writes are async + atomic and a freeze's sync write isn't overwritten", async () => {
    const file = path.join(dir, "l.json")
    const l = new SessionLedger(file)
    l.apply(start())
    await new Promise((r) => setTimeout(r, 700)) // debounce + async write
    expect(JSON.parse(fs.readFileSync(file, "utf8")).p1.sessionId).toBe(ID)
    expect(fs.readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([])
  })
})

describe("SessionLedger.plan", () => {
  it("resume for a restored pane, with the session's cwd and /rename", async () => {
    const l = new SessionLedger(null)
    l.apply(start())
    l.setName("p1", "fix-login")
    expect((await plan(l)).p1).toEqual({
      status: "resume",
      sessionId: ID,
      cwd: "/repo",
      name: "fix-login",
      command: `claude --resume ${ID}`,
    })
  })

  it("skips panes whose PTY is still live (renderer reload — Claude still runs)", async () => {
    const l = new SessionLedger(null)
    l.apply(start())
    expect(await plan(l, ["p1"], () => true)).toEqual({})
  })

  it("preflight: a missing transcript → skip with a reason (nothing gets typed)", async () => {
    const l = new SessionLedger(null)
    l.apply(start())
    expect(
      (
        await plan(
          l,
          ["p1"],
          () => false,
          async () => ({ skip: "its transcript is gone" }),
        )
      ).p1,
    ).toMatchObject({
      status: "skip",
      reason: "its transcript is gone",
    })
  })

  it("preflight unknowable (WSL share) → still resume; claude reports a missing one", async () => {
    const l = new SessionLedger(null)
    l.apply(start(), "Debian")
    const p = (
      await plan(
        l,
        ["p1"],
        () => false,
        async () => ({ unverified: true }),
      )
    ).p1
    expect(p).toMatchObject({ status: "resume", cwdUnverified: true }) // not a spawn cwd
  })

  it("consume is one-shot (the carried entry); prune drops panes no longer in the workspace", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "minmux-ledger-c-"))
    const file = path.join(dir, "l.json")
    const a = new SessionLedger(file)
    a.apply(start())
    a.apply(start({ paneId: "p2", sessionId: ID2 }))
    a.freeze()
    const l = new SessionLedger(file) // relaunch → carried entries
    l.consume("p1", ID)
    l.prune(new Set(["p1"]))
    expect(await plan(l, ["p1", "p2"])).toEqual({})
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it("consume keeps an entry Claude re-recorded this run (late success vs the timeout)", () => {
    const l = new SessionLedger(null)
    l.apply(start({ source: "resume" })) // recorded live this run
    l.consume("p1", ID)
    expect(l.get("p1")?.sessionId).toBe(ID)
  })

  it("a cwd with control characters is never typed: skip", async () => {
    const l = new SessionLedger(null)
    l.apply(start({ cwd: "/x\u0003touch ~/pwned\r" }))
    expect((await plan(l)).p1).toMatchObject({
      status: "skip",
      reason: "its folder name can't be typed safely",
    })
  })
})

describe("SessionLedger persistence", () => {
  let dir: string
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "minmux-ledger-"))
  })
  afterEach(() => {
    vi.useRealTimers()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it("write-through (debounced, async) survives a crash; a new instance reloads it", async () => {
    const file = path.join(dir, "agent-sessions.json")
    const l = new SessionLedger(file)
    l.apply(start())
    await new Promise((r) => setTimeout(r, 700))
    expect(new SessionLedger(file).get("p1")?.sessionId).toBe(ID)
  })

  it("freeze flushes synchronously, atomically (temp + rename)", () => {
    const file = path.join(dir, "agent-sessions.json")
    const l = new SessionLedger(file)
    l.apply(start())
    l.freeze()
    expect(JSON.parse(fs.readFileSync(file, "utf8")).p1.sessionId).toBe(ID)
    expect(fs.existsSync(`${file}.tmp`)).toBe(false)
  })

  it("wrong-typed fields in a hand-edited file are dropped (a non-string name can't reach render)", () => {
    const file = path.join(dir, "agent-sessions.json")
    fs.writeFileSync(
      file,
      JSON.stringify({ p1: { sessionId: ID, cwd: "/r", name: 42, permissionMode: {} } }),
    )
    const e = new SessionLedger(file).get("p1")
    expect(e).toMatchObject({ sessionId: ID, cwd: "/r" })
    expect(e?.name).toBeUndefined()
    expect(e?.permissionMode).toBeUndefined()
  })

  it("a corrupt file starts empty", () => {
    const file = path.join(dir, "agent-sessions.json")
    fs.writeFileSync(file, "{nope")
    expect(new SessionLedger(file).get("p1")).toBeUndefined()
  })
})

describe("SessionLedger — a session launched inside the lead never replaces it", () => {
  it("a background agent's own compact / resume (not just its startup) is nested", () => {
    for (const source of ["startup", "compact", "resume"]) {
      const l = new SessionLedger(null)
      l.apply(start())
      l.apply(start({ sessionId: ID2, source }))
      expect(l.get("p1")?.sessionId, source).toBe(ID)
      expect(l.isNested("p1", ID2)).toBe(true)
      expect(l.isNested("p1", ID)).toBe(false)
    }
  })

  it("/clear or fork switches even if the old session's SessionEnd got lost", () => {
    for (const source of ["clear", "fork"]) {
      const l = new SessionLedger(null)
      l.apply(start())
      l.apply(start({ sessionId: ID2, source }))
      expect(l.get("p1")?.sessionId, source).toBe(ID2)
    }
  })

  it("a nested session stays nested after the lead ends — it never becomes the lead", () => {
    const ID3 = "11111111-2222-4333-8444-555555555555"
    const l = new SessionLedger(null)
    l.apply(start())
    l.apply(start({ sessionId: ID2 })) // the background agent
    l.apply(end()) // the user leaves Claude; the agent keeps running
    l.apply(start({ sessionId: ID2, source: "compact" })) // the agent compacts
    expect(l.get("p1")).toBeUndefined()
    expect(l.isNested("p1", ID2)).toBe(true)
    l.apply(start({ sessionId: ID3 })) // the user's next real claude leads
    expect(l.get("p1")?.sessionId).toBe(ID3)
  })
})

describe("SessionLedger — the folder must be where Claude filed the session", () => {
  const DIMO = "/Users/me/workspace/dimo"
  const tr = (dir: string, id = ID) => `/Users/me/.claude/projects/${dir}/${id}.jsonl`
  const T_DIMO = tr("-Users-me-workspace-dimo")
  const PAD = "/private/tmp/claude-501/-Users-me-workspace-dimo/7aaf8a32/scratchpad"

  it("a SessionStart carrying another folder (a background agent's scratchpad) keeps the real one", () => {
    const l = new SessionLedger(null)
    l.apply(start({ cwd: DIMO, transcriptPath: T_DIMO }))
    expect(
      l.apply(
        start({ cwd: PAD, transcriptPath: T_DIMO, source: "resume", permissionMode: undefined }),
      ),
    ).toEqual({ verdict: "fallback", cwd: DIMO })
    expect(l.get("p1")?.cwd).toBe(DIMO)
    expect(l.get("p1")?.permissionMode).toBe("default") // kept, not wiped by the stray event
  })

  it("/clear while Claude sits in a subfolder: the new session is recorded at the verified folder", () => {
    const l = new SessionLedger(null)
    l.apply(start({ cwd: DIMO, transcriptPath: T_DIMO }))
    l.apply(end({ reason: "clear" }))
    l.apply(
      start({
        sessionId: ID2,
        cwd: `${DIMO}/src`,
        transcriptPath: tr("-Users-me-workspace-dimo", ID2),
        source: "clear",
      }),
    )
    expect(l.get("p1")).toMatchObject({ sessionId: ID2, cwd: DIMO })
  })

  it("no verified folder fits → recorded as the pane's lead (so its agents stay nested) but never resumed", async () => {
    const l = new SessionLedger(null)
    expect(l.apply(start({ cwd: PAD, transcriptPath: T_DIMO }))).toEqual({ verdict: "rejected" })
    expect(l.get("p1")?.sessionId).toBe(ID)
    l.apply(start({ sessionId: ID2 })) // its background agent
    expect(l.isNested("p1", ID2)).toBe(true)
    expect((await plan(l)).p1).toMatchObject({
      status: "skip",
      reason: "its folder doesn't match the session",
    })
  })

  it("the prompt returning after the lead ends keeps its agents nested (they may still run)", () => {
    const l = new SessionLedger(null)
    l.apply(start())
    l.apply(start({ sessionId: ID2 }))
    l.shellIdle("p1") // /exit → the shell prompt is back
    expect(l.get("p1")).toBeUndefined()
    expect(l.isNested("p1", ID2)).toBe(true)
    l.apply(start({ sessionId: ID2, source: "compact" }))
    expect(l.get("p1")).toBeUndefined() // the agent never becomes the lead
    l.drop("p1") // the pane itself closes → forgotten
    expect(l.isNested("p1", ID2)).toBe(false)
  })

  it("later events never move the folder to a non-matching one (cd into a subfolder / scratchpad)", () => {
    const l = new SessionLedger(null)
    l.apply(start({ cwd: DIMO, transcriptPath: T_DIMO }))
    l.apply({ event: "CwdChanged", sessionId: ID, paneId: "p1", cwd: PAD, transcriptPath: T_DIMO })
    l.apply({
      event: "PreToolUse",
      sessionId: ID,
      paneId: "p1",
      cwd: `${DIMO}/src`,
      transcriptPath: T_DIMO,
    })
    expect(l.get("p1")?.cwd).toBe(DIMO)
  })

  it("a session re-filed under a worktree's folder follows it (resume must cd there)", () => {
    const l = new SessionLedger(null)
    const repo = "/Users/me/up/asianf"
    const wt = `${repo}/.claude/worktrees/x`
    l.apply(start({ cwd: repo, transcriptPath: tr("-Users-me-up-asianf") }))
    l.apply({
      event: "CwdChanged",
      sessionId: ID,
      paneId: "p1",
      cwd: wt,
      transcriptPath: tr("-Users-me-up-asianf--claude-worktrees-x"),
    })
    expect(l.get("p1")).toMatchObject({
      cwd: wt,
      transcriptPath: tr("-Users-me-up-asianf--claude-worktrees-x"),
    })
  })

  it("an undecided check (very long path) keeps a restarting session's recorded folder", () => {
    const long = "/Users/me/" + "x".repeat(210)
    const t = tr(claudeProjectDirName(long))
    const l = new SessionLedger(null)
    l.apply(start({ cwd: long, transcriptPath: t }))
    l.apply(start({ cwd: `${long}/packages/a`, transcriptPath: t, source: "compact" }))
    expect(l.get("p1")?.cwd).toBe(long)
  })

  it("an entry recorded with a mismatching folder (before this check) is skipped, never cd'd into", async () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "minmux-ledger-m-")), "l.json")
    fs.writeFileSync(
      file,
      JSON.stringify({ p1: { sessionId: ID, cwd: PAD, transcriptPath: T_DIMO } }),
    )
    const l = new SessionLedger(file)
    expect((await plan(l)).p1).toMatchObject({
      status: "skip",
      reason: "its folder doesn't match the session",
    })
  })
})

describe("SessionLedger — an unverifiable restart never costs a resumable folder", () => {
  it("very long project path: a same-session restart from a short mismatching folder keeps it", async () => {
    const long = "/Users/me/" + "x".repeat(210)
    const t = `/Users/me/.claude/projects/${claudeProjectDirName(long)}/${ID}.jsonl`
    const l = new SessionLedger(null)
    l.apply(start({ cwd: long, transcriptPath: t }))
    l.apply(start({ cwd: "/tmp/x", transcriptPath: t, source: "compact" }))
    expect(l.get("p1")?.cwd).toBe(long)
  })
})

describe("per-agent rules and files (multi-agent)", () => {
  // A second agent with permissive rules: any id, no folder check, `/new` = a switch.
  const OTHER = "11111111-2222-4333-8444-555555555555"
  const otherRules = {
    resumeCommand: (e: { sessionId: string }) => `other resume ${e.sessionId}`,
    cwdFits: () => undefined,
    isSwitch: (ev: AgentEvent) => ev.source === "new",
  }
  const rules = { claude: claudeSessionRules, codex: otherRules }
  const codexStart = (o: Partial<AgentEvent> = {}) =>
    start({ agent: "codex", sessionId: OTHER, transcriptPath: undefined, ...o })
  let dir = ""
  let file = ""
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "minmux-ledger-"))
    file = path.join(dir, "agent-sessions.json")
  })
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))
  const read = (f: string) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"))

  it("keeps each agent's entries in its own file; Claude's file has no agent field", () => {
    const l = new SessionLedger(file, Date.now, rules)
    l.apply(start({ paneId: "p1" }))
    l.apply(codexStart({ paneId: "p2" }))
    l.flushSync()
    expect(Object.keys(read("agent-sessions.json"))).toEqual(["p1", "__minmux"])
    expect(read("agent-sessions.json").p1).not.toHaveProperty("agent")
    expect(Object.keys(read("agent-sessions.codex.json"))).toEqual(["p2"])
    const back = new SessionLedger(file, Date.now, rules)
    expect(back.get("p1")).toMatchObject({ agent: "claude", sessionId: ID, carried: true })
    expect(back.get("p2")).toMatchObject({ agent: "codex", sessionId: OTHER, carried: true })
  })

  it("an older build (Claude-only rules) neither loads nor rewrites another agent's file", () => {
    const l = new SessionLedger(file, Date.now, rules)
    l.apply(codexStart({ paneId: "p2" }))
    l.flushSync()
    const before = fs.readFileSync(path.join(dir, "agent-sessions.codex.json"), "utf8")
    const old = new SessionLedger(file, Date.now, { claude: claudeSessionRules })
    expect(old.get("p2")).toBeUndefined()
    old.apply(start({ paneId: "p1" }))
    old.flushSync()
    expect(fs.readFileSync(path.join(dir, "agent-sessions.codex.json"), "utf8")).toBe(before)
  })

  it("the newest entry wins when two files name the same pane", () => {
    const entry = (sessionId: string, updatedAt: number) => ({ sessionId, cwd: "/repo", updatedAt })
    const marker = { __minmux: { v: 1 } } // written by this build, not an older one
    fs.writeFileSync(file, JSON.stringify({ p1: entry(ID, 100), ...marker }))
    fs.writeFileSync(
      path.join(dir, "agent-sessions.codex.json"),
      JSON.stringify({ p1: entry(OTHER, 200) }),
    )
    expect(new SessionLedger(file, Date.now, rules).get("p1")).toMatchObject({
      agent: "codex",
      sessionId: OTHER,
    })
    fs.writeFileSync(file, JSON.stringify({ p1: entry(ID, 300), ...marker }))
    expect(new SessionLedger(file, Date.now, rules).get("p1")).toMatchObject({
      agent: "claude",
      sessionId: ID,
    })
  })

  it("moving a pane's lead to another agent rewrites both files in one flush", () => {
    const l = new SessionLedger(file, Date.now, rules)
    l.apply(start())
    l.apply(end())
    l.apply(codexStart())
    l.flushSync()
    expect(Object.keys(read("agent-sessions.json"))).toEqual(["__minmux"])
    expect(Object.keys(read("agent-sessions.codex.json"))).toEqual(["p1"])
  })

  it("another agent's session while a lead is live is a background agent, whatever it calls a switch", () => {
    const l = new SessionLedger(null, Date.now, rules)
    l.apply(start())
    l.apply(codexStart({ source: "new" })) // a switch for codex, but Claude leads
    expect(l.get("p1")?.sessionId).toBe(ID)
    expect(l.isNested("p1", OTHER)).toBe(true)
  })

  it("an agent's own switch rule only applies to its own lead", () => {
    const l = new SessionLedger(null, Date.now, rules)
    l.apply(codexStart())
    const NEXT = "99999999-2222-4333-8444-555555555555"
    l.apply(codexStart({ sessionId: NEXT, source: "startup" }))
    expect(l.get("p1")?.sessionId).toBe(OTHER) // not a switch: nested
    l.apply(codexStart({ sessionId: NEXT, source: "new" }))
    expect(l.get("p1")?.sessionId).toBe(OTHER) // still nested: it started as a background agent
    const THIRD = "88888888-2222-4333-8444-555555555555"
    l.apply(codexStart({ sessionId: THIRD, source: "new" }))
    expect(l.get("p1")?.sessionId).toBe(THIRD) // a fresh session that is a switch replaces it
  })

  it("never records an agent it has no rules for", () => {
    const l = new SessionLedger(null, Date.now, { claude: claudeSessionRules })
    l.apply(codexStart())
    expect(l.get("p1")).toBeUndefined()
  })

  it("ignores other agents' files once an older build rewrote Claude's (no marker)", () => {
    const l = new SessionLedger(file, Date.now, rules)
    l.apply(codexStart({ paneId: "p2" }))
    l.flushSync()
    expect(new SessionLedger(file, Date.now, rules).get("p2")).toBeDefined()
    // An older build rewrites only its own entries: the marker is gone.
    fs.writeFileSync(file, JSON.stringify({ p1: { sessionId: ID, cwd: "/repo", updatedAt: 1 } }))
    const after = new SessionLedger(file, Date.now, rules)
    expect(after.get("p2")).toBeUndefined()
    expect(after.get("p1")?.sessionId).toBe(ID)
  })

  it("keeps another agent's file that only missed a write (marker still there)", () => {
    const l = new SessionLedger(file, Date.now, rules)
    l.apply(codexStart({ paneId: "p2" }))
    l.flushSync()
    const old = Date.now() / 1000 - 3600
    fs.utimesSync(path.join(dir, "agent-sessions.codex.json"), old, old) // an old, failed write
    expect(new SessionLedger(file, Date.now, rules).get("p2")?.sessionId).toBe(OTHER)
  })

  it("an older build's loader skips the marker (it has no session id)", () => {
    const l = new SessionLedger(file, Date.now, { claude: claudeSessionRules })
    l.apply(start())
    l.flushSync()
    const raw = read("agent-sessions.json") as Record<string, { sessionId?: unknown }>
    const kept = Object.entries(raw).filter(([, e]) => e && typeof e.sessionId === "string")
    expect(kept.map(([k]) => k)).toEqual(["p1"])
  })

  it("one file that can't be written doesn't block the others", async () => {
    fs.mkdirSync(path.join(dir, "agent-sessions.codex.json")) // a directory: rename onto it fails
    const l = new SessionLedger(file, Date.now, rules)
    l.apply(start({ paneId: "p1" }))
    await new Promise((r) => setTimeout(r, 900)) // the debounced async flush
    expect(Object.keys(read("agent-sessions.json"))).toEqual(["p1", "__minmux"])
    expect(fs.readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]) // tmp cleaned
  })

  it("plans each entry with its own agent's resume command", async () => {
    const l = new SessionLedger(null, Date.now, rules)
    l.apply(start({ paneId: "p1" }))
    l.apply(codexStart({ paneId: "p2" }))
    const out = await plan(l, ["p1", "p2"])
    expect(out.p1?.command).toBe(`claude --resume ${ID}`)
    expect(out.p2?.command).toBe(`other resume ${OTHER}`)
  })
})
