import { describe, expect, it } from "vitest"
import type { RemotePane } from "../../src/lib/remote-protocol"
import { cleanText, firstWrite, refusal, Sender } from "./typing"

const pane = (over: Partial<RemotePane> = {}): RemotePane => ({
  id: "p",
  tab: "t",
  title: "x",
  kind: "agent",
  status: "idle",
  started: true,
  ...over,
})

function setup(p: RemotePane | undefined, after?: Partial<RemotePane>) {
  const writes: string[] = []
  let current = p
  const s = new Sender({
    pane: () => current,
    write: (_id, data) => (writes.push(data), true),
    delay: async () => {
      if (after) current = { ...current!, ...after }
    },
  })
  return { s, writes }
}

describe("typing a phone's message", () => {
  it("cleans control characters, keeps newlines and tabs", () => {
    expect(cleanText("a\x1b[2Jb\r\nc\td\x03")).toBe("a[2Jb\nc\td")
  })

  it("pastes for an agent, then Enter on its own", async () => {
    const { s, writes } = setup(pane({ paste: true }))
    expect(await s.send("d", "p", "fix the test\nplease", "1")).toEqual({ ok: true })
    expect(writes).toEqual(["\x1b[200~fix the test\nplease\x1b[201~", "\r"])
  })

  it("types plainly into a shell without bracketed paste", async () => {
    const { s, writes } = setup(pane({ kind: "shell", paste: false }))
    await s.send("d", "p", "ls", "1")
    expect(writes).toEqual(["ls", "\r"])
    expect(firstWrite("x", true)).toBe("\x1b[200~x\x1b[201~")
  })

  it("refuses while the agent is asking; holds Enter if it started asking meanwhile", async () => {
    expect(await setup(pane({ asking: true })).s.send("d", "p", "x", "1")).toEqual({
      ok: false,
      reason: "waiting",
    })
    const held = setup(pane({ paste: true }), { asking: true })
    expect(await held.s.send("d", "p", "x", "1")).toEqual({ ok: false, reason: "held" })
    expect(held.writes).toEqual(["\x1b[200~x\x1b[201~"]) // no Enter
  })

  it("other refusals", async () => {
    expect(refusal(undefined)).toBe("no-pane")
    expect(refusal(pane({ started: false }))).toBe("not-started")
    expect(refusal(pane({ kind: "shell", status: "waiting" }))).toBeNull()
    expect(refusal(pane({ status: "waiting" }))).toBeNull() // the idle reminder: a message is welcome
    expect(await setup(pane()).s.send("d", "p", "  \x1b ", "1")).toEqual({
      ok: false,
      reason: "empty",
    })
  })

  it("a retried id is typed once", async () => {
    const { s, writes } = setup(pane({ paste: true }))
    await s.send("d", "p", "x", "same")
    await s.send("d", "p", "x", "same")
    expect(writes).toHaveLength(2)
    await s.send("other-device", "p", "x", "same")
    expect(writes).toHaveLength(4)
  })

  it("messages to one pane go one at a time: paste, Enter, then the next", async () => {
    const writes: string[] = []
    let release: () => void = () => {}
    const s = new Sender({
      pane: () => pane({ paste: true }),
      write: (_id, d) => (writes.push(d), true),
      delay: () => new Promise<void>((r) => (release = r)),
    })
    const a = s.send("d", "p", "A", "1")
    const b = s.send("d", "p", "B", "2")
    await new Promise((r) => setTimeout(r, 0))
    expect(writes).toEqual(["\x1b[200~A\x1b[201~"])
    release()
    await a
    await new Promise((r) => setTimeout(r, 0))
    release()
    await b
    expect(writes).toEqual(["\x1b[200~A\x1b[201~", "\r", "\x1b[200~B\x1b[201~", "\r"])
  })

  it("main's own asking state refuses and holds Enter, ahead of the pane list", async () => {
    let asking = false
    const writes: string[] = []
    const s = new Sender({
      pane: () => pane({ paste: true }),
      write: (_id, d) => (writes.push(d), true),
      asking: () => asking,
      delay: async () => {
        asking = true // a permission prompt landed between the paste and Enter
      },
    })
    expect(await s.send("d", "p", "x", "1")).toEqual({ ok: false, reason: "held" })
    expect(await s.send("d", "p", "y", "2")).toEqual({ ok: false, reason: "waiting" })
    expect(writes).toHaveLength(1)
  })

  it("several lines without bracketed paste are refused; a device main refuses can't send", async () => {
    expect(
      await setup(pane({ kind: "shell", paste: false })).s.send("d", "p", "a\nb", "1"),
    ).toEqual({
      ok: false,
      reason: "multiline",
    })
    const s = new Sender({
      pane: () => pane(),
      write: () => true,
      allowed: async () => false,
    })
    expect(await s.send("d", "p", "x", "1")).toEqual({ ok: false, reason: "not-allowed" })
  })

  it("tabs become spaces without bracketed paste; a message queued too long isn't typed", async () => {
    const { s, writes } = setup(pane({ kind: "shell", paste: false }))
    await s.send("d", "p", "git\tstatus", "1")
    expect(writes[0]).toBe("git status")
    let t = 0
    const slow = new Sender({
      pane: () => pane({ paste: true }),
      write: () => true,
      now: () => t,
      delay: async () => {
        t += 25_000 // main stalls on the first message
      },
    })
    const a = slow.send("d", "p", "a", "1")
    const b = slow.send("d", "p", "b", "2")
    expect(await a).toEqual({ ok: true })
    expect(await b).toEqual({ ok: false, reason: "error" })
  })

  it("an agent mid-turn takes nothing; a turn starting between paste and Enter holds it", async () => {
    expect(refusal(pane(), false, false)).toBe("working")
    expect(refusal(pane({ kind: "shell" }), false, false)).toBeNull()
    let between = true
    const writes: string[] = []
    const s = new Sender({
      pane: () => pane({ paste: true }),
      write: (_id, d) => (writes.push(d), true),
      between: () => between,
      delay: async () => {
        between = false // someone at the desktop submitted a prompt meanwhile
      },
    })
    expect(await s.send("d", "p", "x", "1")).toEqual({ ok: false, reason: "held" })
    expect(await s.send("d", "p", "y", "2")).toEqual({ ok: false, reason: "working" })
    expect(writes).toHaveLength(1)
  })

  it("main's own view of an agent pane counts (the list may show a shell after a reload)", async () => {
    const s = new Sender({
      pane: () => pane({ kind: "shell" }),
      write: () => true,
      isAgent: () => true,
      between: () => false,
    })
    expect(await s.send("d", "p", "x", "1")).toEqual({ ok: false, reason: "working" })
    expect(refusal(pane({ kind: "shell", asking: true }))).toBe("waiting") // any pane
  })

  it("asks the terminal's paste mode now; tells main a message was submitted", async () => {
    const writes: string[] = []
    const submitted: string[] = []
    const s = new Sender({
      pane: () => pane({ kind: "shell", paste: true }), // the list still says paste
      write: (_id, d) => (writes.push(d), true),
      pasteNow: async () => false, // the shell just started a command
      submitted: (p) => submitted.push(p),
    })
    expect(await s.send("d", "p", "a\nb", "1")).toEqual({ ok: false, reason: "multiline" })
    expect(await s.send("d", "p", "ls", "2")).toEqual({ ok: true })
    expect(writes).toEqual(["ls", "\r"])
    expect(submitted).toEqual(["p"])
    expect(cleanText("x".repeat(16 * 1024 - 1) + "😀")).toHaveLength(16 * 1024 - 1)
  })

  it("checks again after asking the paste mode (a turn may start meanwhile)", async () => {
    let between = true
    const writes: string[] = []
    const s = new Sender({
      pane: () => pane({ paste: true }),
      write: (_id, d) => (writes.push(d), true),
      between: () => between,
      pasteNow: async () => {
        between = false // Enter at the desktop while main waited
        return true
      },
    })
    expect(await s.send("d", "p", "x", "1")).toEqual({ ok: false, reason: "working" })
    expect(writes).toEqual([])
  })
})
