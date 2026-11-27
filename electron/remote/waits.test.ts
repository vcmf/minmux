import { describe, expect, it } from "vitest"
import { isAnswerKey, WaitTracker } from "./waits"

const P = "pane"
const t = () => new WaitTracker(() => 1)
type E = Parameters<WaitTracker["apply"]>[0]
const run = (w: WaitTracker, ...evs: Partial<E>[]) => {
  for (const e of evs) w.apply({ paneId: P, event: "x", ...e } as E)
  return w.asking(P)
}

describe("wait tracker: Claude", () => {
  it("a permission prompt asks until its call runs", () => {
    const w = t()
    expect(run(w, { event: "PreToolUse", toolKey: "bash1", toolName: "Bash" })).toBe(false)
    expect(
      run(w, {
        event: "Notification",
        notificationType: "permission_prompt",
        message: "Claude needs your permission to use Bash",
      }),
    ).toBe(true)
    expect(w.waits(P)[0]).toMatchObject({ key: "?", kind: "permission" })
    expect(run(w, { event: "PostToolUse", toolKey: "bash1" })).toBe(false)
  })

  it("the idle reminder is not a question, and clears what was open", () => {
    const w = t()
    expect(
      run(w, {
        event: "Notification",
        notificationType: "idle_prompt",
        message: "Claude is waiting for your input",
      }),
    ).toBe(false)
    run(w, { event: "Notification", notificationType: "permission_prompt" })
    expect(run(w, { event: "Notification", message: "Claude is waiting for your input" })).toBe(
      false,
    )
    expect(run(w, { event: "Notification", notificationType: "auth_success" })).toBe(false)
  })

  it("an older Claude without a kind: any other message asks", () => {
    expect(
      run(t(), { event: "Notification", message: "Claude needs your permission to use Edit" }),
    ).toBe(true)
  })

  it("Claude: a parallel call that needed no permission finishing keeps the prompt open", () => {
    const w = t()
    run(w, { event: "PreToolUse", toolKey: "read" }) // needs permission
    run(w, { event: "PreToolUse", toolKey: "grep" }) // allowed
    run(w, { event: "Notification", notificationType: "permission_prompt" })
    expect(run(w, { event: "PostToolUse", toolKey: "grep" })).toBe(true)
    expect(run(w, { event: "PostToolUse", toolKey: "read" })).toBe(false)
  })

  it("a parallel call finishing doesn't close another call's prompt", () => {
    const w = t()
    run(w, { event: "PreToolUse", toolKey: "a" })
    run(w, { event: "PreToolUse", toolKey: "b" })
    run(w, { event: "Notification", notificationType: "permission_prompt" }) // for b
    expect(run(w, { event: "PostToolUse", toolKey: "a" })).toBe(true)
    expect(run(w, { event: "PostToolUse", toolKey: "b" })).toBe(false)
  })

  it("a question tool asks until it returns", () => {
    const w = t()
    expect(run(w, { event: "PreToolUse", toolName: "AskUserQuestion", toolKey: "q" })).toBe(true)
    expect(w.waits(P)[0]!.kind).toBe("question")
    expect(run(w, { event: "PostToolUse", toolName: "AskUserQuestion", toolKey: "q" })).toBe(false)
  })

  it("a sub-agent's prompt counts; its stop closes it; the root's other events don't", () => {
    const w = t()
    run(w, { event: "PreToolUse", agentId: "sub", toolKey: "s1" })
    expect(
      run(w, { event: "Notification", agentId: "sub", notificationType: "permission_prompt" }),
    ).toBe(true)
    expect(run(w, { event: "PostToolUse", toolKey: "rootcall" })).toBe(true)
    expect(run(w, { event: "SubagentStop", agentId: "sub" })).toBe(false)
  })

  it("the turn ending, a new prompt, a session change all close", () => {
    for (const e of ["Stop", "UserPromptSubmit", "SessionStart", "SessionEnd"]) {
      const w = t()
      run(w, { event: "Notification", notificationType: "permission_prompt" })
      expect(run(w, { event: e })).toBe(false)
    }
  })
})

describe("wait tracker: Codex and OpenCode", () => {
  it("Codex: PermissionRequest and its PreToolUse twin in either order", () => {
    const a = t()
    run(a, { event: "PermissionRequest", toolKey: "k" })
    expect(run(a, { event: "PreToolUse", toolKey: "k" })).toBe(true)
    expect(run(a, { event: "PostToolUse", toolKey: "k" })).toBe(false)
    const b = t()
    run(b, { event: "PreToolUse", toolKey: "k" })
    expect(run(b, { event: "PermissionRequest", toolKey: "k" })).toBe(true)
  })

  it("Codex says nothing when answered: the next call shows it moved on", () => {
    const w = t()
    run(w, { event: "PermissionRequest", toolKey: "k", agent: "codex" })
    expect(run(w, { event: "PreToolUse", toolKey: "other", agent: "codex" })).toBe(false)
  })

  it("OpenCode runs calls in parallel: another call starting doesn't close a prompt", () => {
    const w = t()
    run(w, { event: "PreToolUse", toolKey: "a", agent: "opencode" })
    run(w, { event: "PermissionRequest", toolKey: "a", agent: "opencode" })
    expect(run(w, { event: "PreToolUse", toolKey: "b", agent: "opencode" })).toBe(true)
    expect(run(w, { event: "PostToolUse", toolKey: "b", agent: "opencode" })).toBe(true)
    expect(run(w, { event: "PostToolUse", toolKey: "a", agent: "opencode" })).toBe(false)
  })

  it("OpenCode: PermissionReplied closes", () => {
    const w = t()
    run(w, { event: "PermissionRequest", toolKey: "k" })
    expect(run(w, { event: "PermissionReplied" })).toBe(false)
  })
})

describe("wait tracker: the desktop and the pane", () => {
  it("an answer key typed at the desktop closes (Esc denies a Claude prompt without a hook)", () => {
    for (const key of ["\x1b", "\r", "1", "\x03"]) {
      const w = t()
      run(w, { event: "Notification", notificationType: "permission_prompt" })
      w.localInput(P, key)
      expect(w.asking(P)).toBe(false)
    }
    const w = t()
    run(w, { event: "Notification", notificationType: "permission_prompt" })
    w.localInput(P, "\x1b[B") // an arrow moves the choice: still open
    w.localInput(P, "hello")
    expect(w.asking(P)).toBe(true)
    expect(isAnswerKey("\x1b[A")).toBe(false)
    expect(isAnswerKey("y")).toBe(false) // a prompt that ignores it stays up
    expect(isAnswerKey("0")).toBe(false)
  })

  it("the pane closing drops everything; other panes are separate", () => {
    const w = t()
    run(w, { event: "Notification", notificationType: "permission_prompt" })
    w.apply({ paneId: "other", event: "PermissionRequest", toolKey: "k" } as E)
    w.drop(P)
    expect(w.asking(P)).toBe(false)
    expect(w.asking("other")).toBe(true)
    expect(w.any).toBe(true)
    w.apply({ event: "PermissionRequest" } as E) // no pane: ignored
  })

  it("the same dialog reported twice is one wait", () => {
    const w = t()
    run(
      w,
      { event: "PermissionRequest", toolKey: "k" },
      { event: "PermissionRequest", toolKey: "k" },
    )
    expect(w.waits(P)).toHaveLength(1)
  })

  it("picking in a question doesn't close it; Esc dismisses the front one; Ctrl+C all", () => {
    const w = t()
    run(w, { event: "PreToolUse", toolName: "AskUserQuestion", toolKey: "q" })
    expect(w.localInput(P, "1")).toBe(false) // question 1 of 2: the dialog stays
    expect(w.localInput(P, "\r")).toBe(false)
    expect(w.asking(P)).toBe(true)
    expect(w.localInput(P, "\x1b")).toBe(true)
    expect(w.asking(P)).toBe(false)
  })

  it("queued prompts close one per answer", () => {
    const w = t()
    run(w, { event: "PermissionRequest", agentId: "a", toolKey: "k1" })
    run(w, { event: "PermissionRequest", agentId: "b", toolKey: "k2" })
    w.localInput(P, "1")
    expect(w.waits(P).map((x) => x.key)).toEqual(["k2"])
    run(w, { event: "PermissionRequest", agentId: "c", toolKey: "k3" })
    w.localInput(P, "\x03")
    expect(w.asking(P)).toBe(false)
  })

  it("an auto-compaction mid-turn keeps dialogs open", () => {
    const w = t()
    run(w, { event: "Notification", notificationType: "permission_prompt" })
    expect(run(w, { event: "SessionStart", source: "compact" })).toBe(true)
    expect(run(w, { event: "SessionStart", source: "startup" })).toBe(false)
  })
})
