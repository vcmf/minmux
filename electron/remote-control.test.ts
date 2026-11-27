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
    rc.agentEvents([{ paneId: "p1" }])
    // Nobody connected: only the empty list a new worker starts with.
    expect(p.sent.filter((m) => (m as { t: string }).t === "leads")).toEqual([
      { t: "leads", leads: {} },
    ])
    p.emit({ t: "clients", clients: [{ deviceId: "d", name: "iphone" }] })
    expect(p.sent).toContainEqual({
      t: "leads",
      leads: { p1: { agent: "claude", sessionId: "s1", files: ["/t.jsonl", "/t.jsonl.alt"] } },
    })
    rc.agentEvents([{ paneId: "p1" }, { paneId: "p1" }, {}])
    expect(p.sent).toContainEqual({ t: "nudge", panes: ["p1"] })

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
})
