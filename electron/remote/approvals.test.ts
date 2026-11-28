import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createApprovals, isDecision, type ApprovalRequest } from "./approvals"
import type { Decision } from "./devices"

describe("approvals", () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  function setup(window = true) {
    const shown: ApprovalRequest[][] = []
    const natives: { r: ApprovalRequest; signal: AbortSignal; answer: (d: Decision) => void }[] = []
    const a = createApprovals({
      ttlMs: 120_000,
      ackMs: 1500,
      now: () => 1000,
      show: (list) => {
        shown.push(list)
        return window
      },
      native: (r, signal) =>
        new Promise((answer) => {
          natives.push({ r, signal, answer })
        }),
    })
    return { a, shown, natives }
  }

  it("the window shows the request and answers it with a permission", async () => {
    const { a, shown, natives } = setup()
    const p = a.ask("iphone", "K7QM", false)
    expect(shown.at(-1)).toEqual([
      { id: 1, name: "iphone", code: "K7QM", machine: false, expires: 121_000 },
    ])
    a.shown(1)
    vi.advanceTimersByTime(2000)
    expect(natives).toHaveLength(0) // shown in the window: no native prompt
    expect(a.answer(1, "keys")).toBe(true)
    await expect(p).resolves.toBe("keys")
    expect(shown.at(-1)).toEqual([]) // the dialog closes
    expect(a.answer(1, "send")).toBe(false) // already answered
  })

  it("asks natively when there's no window, or the window doesn't show it soon", async () => {
    const none = setup(false)
    const p1 = none.a.ask("iphone", "K7QM", false)
    expect(none.natives).toHaveLength(1)
    none.natives[0]!.answer("allow")
    await expect(p1).resolves.toBe("allow")

    const slow = setup()
    const p2 = slow.a.ask("linux", "ACDE", true)
    expect(slow.natives).toHaveLength(0)
    vi.advanceTimersByTime(1500)
    expect(slow.natives).toHaveLength(1)
    // Answered in the window after all: the native prompt is closed.
    slow.a.answer(1, "view")
    await expect(p2).resolves.toBe("view")
    expect(slow.natives[0]!.signal.aborted).toBe(true)
  })

  it("denies when it expires, on dispose, and ignores answers that aren't one", async () => {
    const { a } = setup()
    const p1 = a.ask("iphone", "K7QM", false)
    a.shown(1)
    expect(a.answer(1, "root")).toBe(false)
    expect(a.answer("1", "send")).toBe(false)
    vi.advanceTimersByTime(120_000)
    await expect(p1).resolves.toBe("deny")
    const p2 = a.ask("ipad", "QQQQ", false)
    a.dispose()
    await expect(p2).resolves.toBe("deny")
    expect(a.list()).toEqual([])
  })

  it("a native prompt that fails denies", async () => {
    const a = createApprovals({
      ttlMs: 1000,
      show: () => false,
      native: () => Promise.reject(new Error("no")),
    })
    await expect(a.ask("x", "AAAA", false)).resolves.toBe("deny")
  })

  it("knows a decision", () => {
    expect(["allow", "deny", "view", "send", "keys"].every(isDecision)).toBe(true)
    expect(isDecision("admin")).toBe(false)
  })
})
