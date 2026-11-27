// @vitest-environment node
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { beforeEach, describe, expect, it, vi } from "vitest"

const forks: { sent: unknown[]; killed: boolean; emit: (m: unknown) => void }[] = []
const showMessageBox = vi.fn(async () => ({ response: 0 }))
vi.mock("electron", () => ({
  dialog: { showMessageBox: (...a: unknown[]) => showMessageBox(...(a as [])) },
  utilityProcess: {
    fork: () => {
      const handlers: ((m: unknown) => void)[] = []
      const p = {
        sent: [] as unknown[],
        killed: false,
        emit: (m: unknown) => handlers.forEach((h) => h(m)),
      }
      forks.push(p)
      return {
        postMessage: (m: unknown) => p.sent.push(m),
        on: (ev: string, fn: (m: unknown) => void) => ev === "message" && handlers.push(fn),
        kill: () => (p.killed = true),
      }
    },
  },
}))

const { autoPort, setupRemoteControl } = await import("./remote-control")
const { dialogSignature, parseDialog } = await import("./agents/answers")

describe("autoPort", () => {
  it("gives the app, a dev build and other profiles their own ports", () => {
    expect(autoPort("")).toBe(7420)
    expect(autoPort("dev")).toBe(7421)
    const p = autoPort("claude-verify")
    expect(p).toBeGreaterThanOrEqual(7430)
    expect(p).toBeLessThan(7490)
    expect(autoPort("claude-verify")).toBe(p)
  })
})

describe("setupRemoteControl", () => {
  let cfg: string
  let settings: string
  beforeEach(() => {
    forks.length = 0
    cfg = fs.mkdtempSync(path.join(os.tmpdir(), "remote-cfg-"))
    settings = "{}"
  })
  const make = () =>
    setupRemoteControl({
      dir: "/app/out/main",
      configDir: () => cfg,
      readSettings: () => settings,
      profile: "dev",
      window: () => null,
    })

  it("starts the worker only when turned on, with this profile's port", async () => {
    const rc = make()
    rc.apply()
    expect(forks).toHaveLength(0)
    expect(await rc.view()).toMatchObject({ enabled: false, port: 7421, status: { state: "off" } })
    settings = JSON.stringify({ remote: { enabled: true } })
    rc.apply()
    expect(forks).toHaveLength(1)
    expect(forks[0]!.sent[0]).toMatchObject({
      t: "config",
      config: { port: 7421, staticDir: path.join("/app/out/main", "../renderer") },
    })
    settings = JSON.stringify({ remote: { enabled: false } })
    rc.apply()
    expect((await rc.view()).status).toEqual({ state: "off" })
    rc.dispose()
  })

  it("devices: PIN, rename, permission, revoke; unknown input refused", async () => {
    const rc = make()
    expect(await rc.setPin("123")).toBe("invalid")
    expect(await rc.setPin(42)).toBe("invalid")
    expect(await rc.setPin("123456")).toBe("ok")
    expect((await rc.view()).hasPin).toBe(true)
    expect(await rc.revoke("nope")).toBe(false)
    expect(await rc.rename(1, "x")).toBe(false)
    expect(await rc.setPermission("nope", "root")).toBe(false)
    expect(rc.wanted()).toBe(false)
    rc.setPanes(null)
    rc.setPanes({ tabs: [], panes: [] })
    rc.windowClosed()
    rc.disconnectAll()
    rc.dispose() // flushes the device file
    const saved = JSON.parse(fs.readFileSync(path.join(cfg, "remote-devices.json"), "utf8"))
    expect(saved.pin).toBeTruthy()
  })

  it("asks with a native dialog showing the code, and approves", async () => {
    settings = JSON.stringify({ remote: { enabled: true } })
    const rc = make()
    rc.apply()
    const p = forks[0]!
    p.emit({ t: "rpc", id: 1, call: { op: "approve", nodeId: "n1", name: "iphone-15" } })
    await vi.waitFor(() => expect(showMessageBox).toHaveBeenCalled())
    const reply = await vi.waitFor(() => {
      const r = p.sent.find((m) => (m as { t: string; id?: number }).t === "rpc") as {
        result: { result: { id: string } }
      }
      expect(r).toBeTruthy()
      return r
    })
    const opts = (showMessageBox.mock.calls[0] as unknown[]).at(-1) as {
      detail: string
      message: string
    }
    expect(opts.message).toBe("iphone-15 wants to control minmux")
    await vi.waitFor(async () => expect((await rc.view()).devices).toHaveLength(1))
    expect(reply.result.result.id).toMatch(/^[0-9a-f]{32}$/)
    expect(opts.detail).toMatch(/code [A-Z0-9]{4}/)
    expect((await rc.view()).devices[0]!.permission).toBe("send")
    rc.dispose()
  })

  it("while someone's connected: leads and nudges for the chat, messages typed into panes", async () => {
    settings = JSON.stringify({ remote: { enabled: true } })
    const writes: [string, string][] = []
    const rc = setupRemoteControl({
      dir: "/app/out/main",
      configDir: () => cfg,
      readSettings: () => settings,
      profile: "",
      window: () => null,
      leadOf: (pane) =>
        pane === "p1" ? { agent: "claude", sessionId: "s1", transcriptPath: "/t.jsonl" } : null,
      transcriptTargets: (p) => [p, `${p}.alt`],
      writePty: (pane, data) => (writes.push([pane, data]), true),
    })
    rc.apply()
    const p = forks[0]!
    rc.setPanes({
      tabs: [],
      panes: [
        {
          id: "p1",
          tab: "t",
          title: "a",
          kind: "agent",
          status: "idle",
          started: true,
          paste: true,
        },
      ],
    })
    rc.agentEvents([{ paneId: "p1", event: "PostToolUse" }])
    // Nobody connected: only the empty list a new worker starts with.
    expect(p.sent.filter((m) => (m as { t: string }).t === "leads")).toEqual([
      { t: "leads", leads: {} },
    ])
    p.emit({ t: "clients", clients: [{ deviceId: "d", name: "iphone" }] })
    expect(p.sent).toContainEqual({
      t: "leads",
      leads: { p1: { agent: "claude", sessionId: "s1", files: ["/t.jsonl", "/t.jsonl.alt"] } },
    })
    rc.agentEvents([
      { paneId: "p1", event: "PostToolUse" },
      { paneId: "p1", event: "PostToolUse" },
      { event: "Stop" },
    ])
    expect(p.sent).toContainEqual({ t: "nudge", panes: ["p1"] })

    // Mid-turn the agent takes nothing; once its turn ends it does.
    rc.agentEvents([{ paneId: "p1", event: "Stop" }])
    // An unknown device can't type; an approved one can.
    p.emit({
      t: "rpc",
      id: 8,
      call: { op: "send", deviceId: "nope", pane: "p1", text: "go", id: "w" },
    })
    await vi.waitFor(() =>
      expect(p.sent).toContainEqual({
        t: "rpc",
        id: 8,
        result: { op: "send", result: { ok: false, reason: "not-allowed" } },
      }),
    )
    p.emit({ t: "rpc", id: 7, call: { op: "approve", nodeId: "n1", name: "iphone" } })
    await vi.waitFor(async () => expect((await rc.view()).devices).toHaveLength(1))
    const deviceId = (await rc.view()).devices[0]!.id
    p.emit({ t: "rpc", id: 9, call: { op: "send", deviceId, pane: "p1", text: "go", id: "x" } })
    await vi.waitFor(() =>
      expect(p.sent).toContainEqual({
        t: "rpc",
        id: 9,
        result: { op: "send", result: { ok: true } },
      }),
    )
    expect(writes).toEqual([
      ["p1", "\x1b[200~go\x1b[201~"],
      ["p1", "\r"],
    ])
    rc.dispose()
  })

  it("a permission prompt marks the pane asking for devices; the idle reminder doesn't", () => {
    settings = JSON.stringify({ remote: { enabled: true } })
    const rc = make()
    rc.apply()
    const p = forks[0]!
    rc.setPanes({
      tabs: [],
      panes: [{ id: "p1", tab: "t", title: "a", kind: "agent", status: "idle", started: true }],
    })
    const lastPanes = () =>
      (
        p.sent.filter((m) => (m as { t: string }).t === "panes").at(-1) as {
          panes: { panes: { asking?: boolean; detail?: string }[] }
        }
      ).panes.panes[0]!
    rc.agentEvents([{ paneId: "p1", event: "Notification", notificationType: "idle_prompt" }])
    expect(lastPanes().asking).toBeUndefined()
    rc.agentEvents([
      {
        paneId: "p1",
        event: "Notification",
        notificationType: "permission_prompt",
        message: "Claude needs your permission to use Bash",
      },
    ])
    expect(lastPanes()).toMatchObject({
      asking: true,
      detail: "Claude needs your permission to use Bash",
    })
    rc.localInput("p1", "\x1b") // Esc at the desktop
    expect(lastPanes().asking).toBeUndefined()
    rc.agentEvents([{ paneId: "p1", event: "PermissionRequest", toolKey: "k" }])
    rc.paneGone("p1")
    expect(lastPanes().asking).toBeUndefined()
    rc.dispose()
  })

  it("a background session in the pane says nothing about the lead's turn", () => {
    settings = JSON.stringify({ remote: { enabled: true } })
    const rc = setupRemoteControl({
      dir: "/app/out/main",
      configDir: () => cfg,
      readSettings: () => settings,
      profile: "",
      window: () => null,
      leadOf: () => ({ agent: "claude", sessionId: "lead" }),
    })
    rc.apply()
    const p = forks[0]!
    rc.setPanes({
      tabs: [],
      panes: [{ id: "p1", tab: "t", title: "a", kind: "agent", status: "idle", started: true }],
    })
    const last = () =>
      (
        p.sent.filter((m) => (m as { t: string }).t === "panes").at(-1) as {
          panes: { panes: { working?: boolean }[] }
        }
      ).panes.panes[0]!
    expect(last().working).toBe(true) // no Stop seen yet
    rc.agentEvents([{ paneId: "p1", sessionId: "lead", event: "Stop" }])
    expect(last().working).toBeUndefined()
    rc.agentEvents([{ paneId: "p1", sessionId: "bg", event: "UserPromptSubmit" }])
    rc.agentEvents([{ paneId: "p1", sessionId: "lead", event: "PreToolUse", nested: true }])
    expect(last().working).toBeUndefined()
    rc.agentEvents([{ paneId: "p1", sessionId: "lead", event: "UserPromptSubmit" }])
    expect(last().working).toBe(true)
    // The agent crashed: the shell's prompt came back. Its pane no longer counts as an agent's.
    rc.shellIdle("p1")
    expect(last().working).toBeUndefined()
    // A new session there makes it an agent pane again (working until it says otherwise).
    rc.agentEvents([{ paneId: "p1", sessionId: "lead", event: "SessionStart", source: "startup" }])
    expect(last().working).toBeUndefined()
    rc.agentEvents([{ paneId: "p1", sessionId: "lead", event: "UserPromptSubmit" }])
    expect(last().working).toBe(true)
    rc.dispose()
  })

  it("raw keys: only devices allowed them, only listed panes; they count as desktop keys", async () => {
    settings = JSON.stringify({ remote: { enabled: true } })
    const writes: [string, string][] = []
    const rc = setupRemoteControl({
      dir: "/app/out/main",
      configDir: () => cfg,
      readSettings: () => settings,
      profile: "",
      window: () => null,
      writePty: (pane, data) => (writes.push([pane, data]), true),
      terminal: { snapshot: () => null, untap: () => {}, untapAll: () => {} },
    })
    rc.apply()
    const p = forks[0]!
    rc.setPanes({
      tabs: [],
      panes: [{ id: "p1", tab: "t", title: "a", kind: "shell", status: "idle", started: true }],
    })
    p.emit({ t: "rpc", id: 1, call: { op: "approve", nodeId: "n1", name: "iphone" } })
    await vi.waitFor(async () => expect((await rc.view()).devices).toHaveLength(1))
    const id = (await rc.view()).devices[0]!.id
    const keys = (rid: number, pane: string) =>
      p.emit({ t: "rpc", id: rid, call: { op: "keys", deviceId: id, pane, data: "\u0003" } })
    keys(2, "p1")
    await vi.waitFor(() =>
      expect(p.sent).toContainEqual({ t: "rpc", id: 2, result: { op: "keys", result: false } }),
    )
    await rc.setPermission(id, "keys")
    keys(3, "p1")
    keys(4, "nope")
    await vi.waitFor(() =>
      expect(p.sent).toContainEqual({ t: "rpc", id: 3, result: { op: "keys", result: true } }),
    )
    await vi.waitFor(() =>
      expect(p.sent).toContainEqual({ t: "rpc", id: 4, result: { op: "keys", result: false } }),
    )
    expect(writes).toEqual([["p1", "\u0003"]])
    rc.dispose()
  })

  it("the tap: batches, resets and sizes go to the worker; its exit stops every tap", () => {
    settings = JSON.stringify({ remote: { enabled: true } })
    let untapped = 0
    const rc = setupRemoteControl({
      dir: "/app/out/main",
      configDir: () => cfg,
      readSettings: () => settings,
      profile: "",
      window: () => null,
      terminal: { snapshot: () => null, untap: () => {}, untapAll: () => void untapped++ },
    })
    rc.apply()
    const p = forks[0]!
    rc.tapOutput("p1", 2, 10, "abc")
    rc.tapReset("p1")
    rc.tapResize("p1", 100, 30)
    expect(p.sent).toContainEqual({ t: "tout", pane: "p1", epoch: 2, offset: 10, data: "abc" })
    expect(p.sent).toContainEqual({ t: "treset", pane: "p1" })
    expect(p.sent).toContainEqual({ t: "tsize", pane: "p1", cols: 100, rows: 30 })
    settings = JSON.stringify({ remote: { enabled: false } })
    rc.apply() // the worker stops: its taps go with it
    expect(untapped).toBe(1)
    rc.dispose()
  })

  it("answers: only the open dialog, only an option still on screen, only agents that take numbers", async () => {
    settings = JSON.stringify({ remote: { enabled: true } })
    let onScreen: string[] = []
    let windowOpen = true
    let started = true
    let duringRead = async () => {}
    const writes: [string, string][] = []
    const rc = setupRemoteControl({
      dir: "/app/out/main",
      configDir: () => cfg,
      readSettings: () => settings,
      profile: "",
      window: () => null,
      leadOf: () => ({ agent: "claude", sessionId: "s" }),
      writePty: (pane, data) => (writes.push([pane, data]), true),
      screen: async () => {
        await duringRead()
        return windowOpen ? (started ? onScreen : null) : undefined
      },
    })
    rc.apply()
    const p = forks[0]!
    rc.setPanes({
      tabs: [],
      panes: [{ id: "p1", tab: "t", title: "a", kind: "agent", status: "waiting", started: true }],
    })
    p.emit({ t: "rpc", id: 1, call: { op: "approve", nodeId: "n1", name: "iphone" } })
    await vi.waitFor(async () => expect((await rc.view()).devices).toHaveLength(1))
    const deviceId = (await rc.view()).devices[0]!.id
    rc.agentEvents([{ paneId: "p1", event: "Notification", notificationType: "permission_prompt" }])
    const waitId = (
      p.sent.filter((m) => (m as { t: string }).t === "panes").at(-1) as {
        panes: { panes: { waitId?: string }[] }
      }
    ).panes.panes[0]!.waitId!
    expect(waitId).toBeTruthy()
    const screen = ["────────", "Do you want to proceed?", "❯ 1. Yes", "  2. No"]
    onScreen = screen
    let rid = 10
    const sig = (lines: string[]) => dialogSignature(parseDialog(lines)!)
    const answer = async (o: {
      waitId?: string
      n?: number
      seen?: string
      lines?: string[]
      deadline?: number
    }) => {
      onScreen = o.lines ?? screen
      const id = ++rid
      p.emit({
        t: "rpc",
        id,
        call: {
          op: "answer",
          deviceId,
          pane: "p1",
          waitId: o.waitId ?? waitId,
          n: o.n ?? 1,
          seen: o.seen ?? sig(screen),
          deadline: o.deadline ?? Date.now() + 5000,
        },
      })
      return vi.waitFor(() => {
        const r = p.sent.find((m) => (m as { id?: number }).id === id) as {
          result: { result: { ok: boolean; reason?: string } }
        }
        expect(r).toBeTruthy()
        return r.result.result
      })
    }
    p.emit({ t: "rpc", id: 5, call: { op: "answerable", pane: "p1" } })
    await vi.waitFor(() =>
      expect(p.sent.find((m) => (m as { id?: number }).id === 5)).toMatchObject({
        result: { result: true },
      }),
    )
    expect(await answer({ waitId: "w999" })).toEqual({ ok: false, reason: "stale" })
    // The device was shown another dialog (another command under the same question).
    expect(
      await answer({
        seen: sig(["────────", "Do you want to proceed?", "❯ 1. Yes", "  2. Maybe"]),
      }),
    ).toEqual({
      ok: false,
      reason: "changed",
    })
    expect(await answer({ lines: ["$ "] })).toEqual({ ok: false, reason: "changed" })
    // A question dialog on screen (not a go-ahead prompt): no digit, whatever the tracker says.
    const question = ["Which target?", "› 1. Staging", "  2. Production"]
    expect(await answer({ lines: question, seen: sig(question) })).toEqual({
      ok: false,
      reason: "changed",
    })
    windowOpen = false
    expect(await answer({})).toEqual({ ok: false, reason: "no-window" })
    windowOpen = true
    // The window has no terminal for it (a background tab not started since a reload).
    started = false
    expect(await answer({})).toEqual({ ok: false, reason: "unsupported" })
    started = true
    // The desktop answers while main reads the screen, and the agent asks again: not that one.
    duringRead = async () => {
      duringRead = async () => {}
      rc.localInput("p1", "1")
      rc.agentEvents([
        { paneId: "p1", event: "Notification", notificationType: "permission_prompt" },
      ])
    }
    expect(await answer({})).toEqual({ ok: false, reason: "stale" })
    expect(writes).toEqual([])
    const waitId2 = (
      p.sent.filter((m) => (m as { t: string }).t === "panes").at(-1) as {
        panes: { panes: { waitId?: string }[] }
      }
    ).panes.panes[0]!.waitId!
    expect(waitId2).not.toBe(waitId)
    expect(await answer({ waitId: waitId2, deadline: Date.now() - 1 })).toEqual({
      ok: false,
      reason: "error",
    })
    expect(writes).toEqual([])
    expect(await answer({ waitId: waitId2 })).toEqual({ ok: true })
    expect(writes).toEqual([["p1", "1"]])
    expect(await answer({ waitId: waitId2 })).toEqual({ ok: false, reason: "stale" }) // answered
    // A Codex dialog: its keys aren't verified, so nothing is typed.
    rc.agentEvents([{ paneId: "p1", event: "PermissionRequest", agent: "codex", toolKey: "k" }])
    const codexWait = (
      p.sent.filter((m) => (m as { t: string }).t === "panes").at(-1) as {
        panes: { panes: { waitId?: string }[] }
      }
    ).panes.panes[0]!.waitId!
    expect(await answer({ waitId: codexWait })).toEqual({ ok: false, reason: "unsupported" })
    expect(writes).toHaveLength(1)
    rc.dispose()
  })
})
