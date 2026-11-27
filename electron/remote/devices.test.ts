import { describe, expect, it } from "vitest"
import {
  DeviceTable,
  EXPIRE_AFTER_MS,
  FILE_VERSION,
  LOCK_AFTER_MS,
  PENDING_MS,
  PIN_TRIES_PER_DEVICE,
  PIN_TRIES_PER_HOUR,
  parseDeviceFile,
} from "./devices"

function setup(raw: string | null = null) {
  let t = 1_000_000
  let n = 0
  const saved: string[] = []
  const table = new DeviceTable(raw, {
    now: () => t,
    random: (len) => Buffer.alloc(len, ++n),
    save: (c) => saved.push(c),
    derive: async (pin, salt) => Buffer.from(`${salt}:${pin}`).toString("hex"),
  })
  return {
    table,
    saved,
    advance: (ms: number) => (t += ms),
  }
}

function approve(table: DeviceTable, nodeId = "n1", decision: "allow" | "view" = "allow") {
  const p = table.createPending(nodeId, "iphone-15")!
  expect(table.decide(p.id, decision)).toBe(true)
  const s = table.pendingState(p.id, nodeId)
  if (s.state !== "approved") throw new Error(s.state)
  return s.token
}

describe("DeviceTable approval", () => {
  it("issues a token to the node and page that asked, once", () => {
    const { table } = setup()
    const p = table.createPending("n1", "iphone-15")!
    expect(p.code).toMatch(/^[A-Z0-9]{4}$/)
    expect(table.pendingState(p.id, "n1")).toEqual({ state: "pending", code: p.code })
    table.decide(p.id, "allow")
    expect(table.pendingState(p.id, "other-node").state).toBe("expired")
    const s = table.pendingState(p.id, "n1")
    expect(s.state).toBe("approved")
    expect(table.pendingState(p.id, "n1").state).toBe("expired")
    const token = (s as { token: string }).token
    expect(table.auth(token, "n1").state).toBe("ok")
    expect(table.auth(token, "n2").state).toBe("none") // bound to its node
    expect(table.list()[0]!.permission).toBe("send")
  })

  it("view only and deny", () => {
    const { table } = setup()
    approve(table, "n1", "view")
    expect(table.list()[0]!.permission).toBe("view")
    const p = table.createPending("n2", "pixel")!
    table.decide(p.id, "deny")
    expect(table.pendingState(p.id, "n2").state).toBe("denied")
    expect(table.list()).toHaveLength(1)
  })

  it("rate-limits prompts per node", () => {
    const { table, advance } = setup()
    const a = table.createPending("n1", "x")!
    expect(table.createPending("n1", "x")).toBeNull() // one pending at a time
    table.decide(a.id, "deny")
    table.pendingState(a.id, "n1")
    expect(table.createPending("n1", "x")).not.toBeNull()
    advance(PENDING_MS)
    expect(table.createPending("n1", "x")).not.toBeNull()
    advance(PENDING_MS)
    expect(table.createPending("n1", "x")).toBeNull() // 3 in 10 minutes
    expect(table.createPending("n2", "y")).not.toBeNull()
  })

  it("expires an unanswered prompt, and drops a device whose page never collected it", () => {
    const { table, advance } = setup()
    const p = table.createPending("n1", "x")!
    advance(PENDING_MS)
    expect(table.decide(p.id, "allow")).toBe(false)
    const q = table.createPending("n1", "x")!
    table.decide(q.id, "allow")
    expect(table.list()).toHaveLength(1)
    advance(PENDING_MS)
    expect(table.pendingState(q.id, "n1").state).toBe("expired")
    expect(table.list()).toHaveLength(0)
  })

  it("names a second device on the same name apart", () => {
    const { table } = setup()
    approve(table, "n1")
    approve(table, "n1")
    expect(table.list().map((d) => d.name)).toEqual(["iphone-15", "iphone-15 (2)"])
  })
})

describe("DeviceTable lock, PIN and expiry", () => {
  it("locks after 24 h without use; activity keeps it open", () => {
    const { table, advance } = setup()
    const token = approve(table)
    const id = table.list()[0]!.id
    advance(LOCK_AFTER_MS - 1000)
    table.touch(id)
    advance(LOCK_AFTER_MS - 1000)
    expect(table.auth(token, "n1").state).toBe("ok")
    advance(2000)
    expect(table.auth(token, "n1")).toMatchObject({ state: "locked", pin: false })
    expect(table.permissionOf(id)).toBeNull()
    table.touch(id) // never unlocks
    expect(table.auth(token, "n1").state).toBe("locked")
  })

  it("unlocks with the PIN", async () => {
    const { table, advance } = setup()
    expect(await table.setPin("12345")).toBe(false) // too short
    expect(await table.setPin("123456")).toBe(true)
    const token = approve(table)
    advance(LOCK_AFTER_MS)
    expect(table.auth(token, "n1")).toMatchObject({ state: "locked", pin: true })
    expect(await table.unlock(token, "n1", "000000")).toBe("wrong")
    expect(await table.unlock(token, "n1", "123456")).toBe("ok")
    expect(table.auth(token, "n1").state).toBe("ok")
    expect(await table.unlock(token, "n2", "123456")).toBe("unknown")
  })

  it("removes a device after 5 wrong PINs", async () => {
    const { table, advance } = setup()
    await table.setPin("123456")
    const token = approve(table)
    advance(LOCK_AFTER_MS)
    for (let i = 1; i < PIN_TRIES_PER_DEVICE; i++)
      expect(await table.unlock(token, "n1", "1")).toBe("wrong")
    expect(await table.unlock(token, "n1", "1")).toBe("blocked")
    expect(table.auth(token, "n1").state).toBe("none")
  })

  it("turns PIN unlocking off after 10 wrong PINs in an hour, until a new PIN is set", async () => {
    const { table, advance } = setup()
    await table.setPin("123456")
    const tokens = [approve(table, "a"), approve(table, "b"), approve(table, "c")]
    advance(LOCK_AFTER_MS)
    let fails = 0
    for (const [i, t] of tokens.entries()) {
      for (let k = 0; k < 4 && fails < PIN_TRIES_PER_HOUR; k++, fails++)
        await table.unlock(t, "abc"[i]!, "9")
    }
    expect(table.pinUnlockOff).toBe(true)
    expect(await table.unlock(tokens[2]!, "c", "123456")).toBe("disabled")
    expect(table.auth(tokens[2]!, "c")).toMatchObject({ state: "locked", pin: false })
    await table.setPin("654321")
    expect(await table.unlock(tokens[2]!, "c", "654321")).toBe("ok")
  })

  it("expires devices unused for 30 days", () => {
    const { table, advance } = setup()
    const token = approve(table)
    advance(EXPIRE_AFTER_MS)
    expect(table.auth(token, "n1").state).toBe("none")
    expect(table.list()).toHaveLength(0)
  })

  it("revoke, rename, permission", () => {
    const { table } = setup()
    const token = approve(table)
    const id = table.list()[0]!.id
    expect(table.rename(id, "  my phone ")).toBe(true)
    expect(table.setPermission(id, "keys")).toBe(true)
    expect(table.list()[0]).toMatchObject({ name: "my phone", permission: "keys" })
    expect(table.revoke(id)).toBe(true)
    expect(table.auth(token, "n1").state).toBe("none")
  })
})

describe("device file", () => {
  it("round-trips through save", () => {
    const { table, saved } = setup()
    const token = approve(table)
    const again = setup(saved.at(-1)!)
    expect(again.table.auth(token, "n1").state).toBe("ok")
    expect(saved.at(-1)).not.toContain(token) // only its hash
  })

  it("never overwrites a newer build's file", async () => {
    const raw = JSON.stringify({ v: FILE_VERSION + 1, devices: [] })
    expect(parseDeviceFile(raw).newer).toBe(true)
    const { table, saved } = setup(raw)
    expect(table.newerFile).toBe(true)
    expect(table.createPending("n1", "x")).toBeNull()
    expect(await table.setPin("123456")).toBe(false)
    expect(saved).toHaveLength(0)
  })

  it("drops malformed entries", () => {
    const raw = JSON.stringify({ v: 1, devices: [{ id: 1 }, null, { id: "a" }] })
    expect(parseDeviceFile(raw).file.devices).toEqual([])
    expect(parseDeviceFile("{oops").file.devices).toEqual([])
  })
})
