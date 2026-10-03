import { describe, it, expect } from "vitest"
import { isDefaultTitle, namesReader, OpencodeNames } from "./opencode-names"
import type { AgentEvent } from "../../src/lib/agent-graph"

const DEFAULT = "New session - 2026-10-01T14:22:48.934Z"
const ev = (event: string, o: Partial<AgentEvent> = {}): AgentEvent => ({
  agent: "opencode",
  event,
  sessionId: "ses_a",
  paneId: "p",
  ...o,
})
const start = (source: "startup" | "resume") => ev("SessionStart", { source, cwd: "/r" })
const title = (t: string) => ev("SessionTitle", { title: t })
const prompt = ev("UserPromptSubmit")

describe("OpencodeNames", () => {
  it("default → OpenCode's automatic title (no colour) → the user's /rename (colour)", () => {
    const n = new OpencodeNames()
    n.apply(start("startup"))
    n.apply(title(DEFAULT))
    expect(n.meta("ses_a")).toEqual({}) // the placeholder is no name
    n.apply(prompt)
    n.apply(title("Fix the login bug"))
    expect(n.meta("ses_a")).toEqual({ name: "Fix the login bug", auto: true })
    n.apply(title("auth-rework"))
    expect(n.meta("ses_a")).toEqual({ name: "auth-rework" })
    n.apply(title("auth-rework")) // the same title again changes nothing
    expect(n.meta("ses_a")).toEqual({ name: "auth-rework" })
  })

  it("a rename before the first prompt is the user's", () => {
    const n = new OpencodeNames()
    n.apply(start("startup"))
    n.apply(title(DEFAULT))
    n.apply(title("spike"))
    expect(n.meta("ses_a")).toEqual({ name: "spike" })
  })

  it("a session from before (resumed, picked): its name as recorded, else OpenCode's", () => {
    const user = new OpencodeNames((id) => (id === "ses_a" ? true : undefined))
    // A resumed session's title comes before its start (its prompt brings session.updated).
    user.apply(title("auth-rework"))
    user.apply(start("resume"))
    expect(user.meta("ses_a")).toEqual({ name: "auth-rework" })
    const unknown = new OpencodeNames()
    unknown.apply(title("Fix the login bug"))
    expect(unknown.meta("ses_a")).toEqual({ name: "Fix the login bug", auto: true })
    unknown.apply(title("mine")) // renamed now: the user's
    expect(unknown.meta("ses_a")).toEqual({ name: "mine" })
  })

  it("kept after its session ends: it may be picked again or resumed this run", () => {
    const n = new OpencodeNames()
    n.apply(title("mine"))
    n.apply(title("renamed"))
    n.apply(ev("SessionEnd", { reason: "exited" }))
    expect(n.meta("ses_a")).toEqual({ name: "renamed" })
  })

  it("renamed before the first prompt, then again after: both the user's", () => {
    const n = new OpencodeNames()
    n.apply(start("startup"))
    n.apply(title(DEFAULT))
    n.apply(title("spike")) // before any prompt: OpenCode won't title it now
    n.apply(prompt)
    n.apply(title("spike2"))
    expect(n.meta("ses_a")).toEqual({ name: "spike2" })
  })

  it("a session from before still on its placeholder: a rename before a prompt is the user's", () => {
    const n = new OpencodeNames()
    n.apply(title(DEFAULT)) // `opencode -s` on a never-titled session
    n.apply(title("mine"))
    expect(n.meta("ses_a")).toEqual({ name: "mine" })
    const later = new OpencodeNames()
    later.apply(title(DEFAULT))
    later.apply(prompt)
    later.apply(title("Fix the bug")) // its first prompt here: OpenCode titles it
    expect(later.meta("ses_a")).toEqual({ name: "Fix the bug", auto: true })
  })

  it("ignores sub-agents and other events; reads through the meta tracker's interface", async () => {
    const n = new OpencodeNames()
    n.apply(ev("SessionTitle", { title: "child", agentId: "ses_c" }))
    n.apply(ev("PreToolUse"))
    expect(n.meta("ses_a")).toEqual({})
    n.apply(title("x"))
    expect(await namesReader(n).update("opencode:titles", [], "ses_a")).toEqual({
      name: "x",
      auto: true,
    })
    expect(await namesReader(n).update("opencode:titles", [])).toEqual({})
  })

  it("a session created with a real title (a fork) is OpenCode's, not the user's", () => {
    const n = new OpencodeNames()
    n.apply(start("startup"))
    n.apply(title("Fix login (fork #1)"))
    expect(n.meta("ses_a")).toEqual({ name: "Fix login (fork #1)", auto: true })
  })

  it("the placeholder re-sent after a prompt (a reloaded plugin) still counts that prompt", () => {
    const n = new OpencodeNames()
    n.apply(title(DEFAULT))
    n.apply(prompt)
    n.apply(title(DEFAULT))
    n.apply(title("Fix the bug"))
    expect(n.meta("ses_a")).toEqual({ name: "Fix the bug", auto: true })
  })

  it("records whose name it is, per session", () => {
    const seen: [string, boolean][] = []
    const n = new OpencodeNames(undefined, (id, user) => seen.push([id, user]))
    n.apply(title(DEFAULT))
    n.apply(prompt)
    n.apply(title("Fix the bug"))
    n.apply(title("auth-rework"))
    expect(seen).toEqual([
      ["ses_a", false],
      ["ses_a", true],
    ])
  })

  it("knows OpenCode's placeholder title", () => {
    expect(isDefaultTitle(DEFAULT)).toBe(true)
    expect(isDefaultTitle("New session ideas")).toBe(false)
  })
})
