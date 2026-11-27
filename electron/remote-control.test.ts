import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { beforeEach, describe, expect, it, vi } from "vitest"

const forks: { sent: unknown[]; killed: boolean }[] = []
const showMessageBox = vi.fn(async () => ({ response: 0 }))
vi.mock("electron", () => ({
  dialog: { showMessageBox: (...a: unknown[]) => showMessageBox(...(a as [])) },
  utilityProcess: {
    fork: () => {
      const p = { sent: [] as unknown[], killed: false }
      forks.push(p)
      return {
        postMessage: (m: unknown) => p.sent.push(m),
        on: () => {},
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
})
