import { describe, expect, it } from "vitest"
import { acked, applyChat, emptyChat, refusalText, resendable, type Outgoing } from "./chat-state"

const u = (id: string, text = id) => ({ id, kind: "user" as const, text })

describe("applyChat", () => {
  it("reset, upsert by id, older before", () => {
    let s = applyChat(emptyChat, {
      t: "chat",
      pane: "p",
      items: [u("b"), u("c")],
      reset: true,
      more: true,
    })
    expect(s).toMatchObject({ loaded: true, more: true })
    s = applyChat(s, { t: "chat", pane: "p", items: [u("c", "C!"), u("d")] })
    expect(s.items.map((i) => (i as { text: string }).text)).toEqual(["b", "C!", "d"])
    s = applyChat(s, { t: "chat", pane: "p", items: [u("a"), u("b")], older: true, more: false })
    expect(s.items.map((i) => i.id)).toEqual(["a", "b", "c", "d"])
    expect(s.more).toBe(false)
    s = applyChat(s, { t: "chat", pane: "p", items: [], reset: true, unavailable: "no-agent" })
    expect(s).toMatchObject({ items: [], unavailable: "no-agent" })
  })
})

describe("applyChat ordering", () => {
  const q = (id: string, seq: number) => ({ id, kind: "user" as const, text: id, seq })
  it("puts a late item in its place; ignores one older than what's loaded", () => {
    let s = applyChat(emptyChat, {
      t: "chat",
      pane: "p",
      items: [q("b", 5), q("d", 7)],
      reset: true,
    })
    s = applyChat(s, { t: "chat", pane: "p", items: [q("c", 6), q("a", 2), q("e", 8)] })
    expect(s.items.map((i) => i.id)).toEqual(["b", "c", "d", "e"])
  })
})

describe("outbox", () => {
  const o = (id: string, at: number, state: Outgoing["state"] = "sending"): Outgoing => ({
    id,
    pane: "p",
    text: "x",
    at,
    state,
  })

  it("resends young unanswered messages once, fails old ones", () => {
    const { again, next } = resendable([o("a", 50_000), o("b", 0), o("c", 0, "sent")], 70_000)
    expect(again.map((x) => x.id)).toEqual(["a"])
    expect(next.map((x) => x.state)).toEqual(["sending", "failed", "sent"])
    expect(next[1]!.reason).toBe("offline")
  })

  it("acks land on their message", () => {
    const out = acked([o("a", 0), o("b", 0)], { t: "ack", id: "b", ok: false, reason: "waiting" })
    expect(out[1]).toMatchObject({ state: "failed", reason: "waiting" })
    expect(refusalText("waiting")).toMatch(/asking/)
    expect(acked(out, { t: "ack", id: "a", ok: true })[0]!.state).toBe("sent")
  })
})
