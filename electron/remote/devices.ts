// Remote control's device table (main only: the worker that parses network input holds no
// authority). Approved devices, their tokens (hashed), permissions, the idle lock (24 h), the
// PIN that lifts it, and expiry (30 days unused). Persisted to remote-devices.json by the caller.

import crypto from "node:crypto"
import type { Permission } from "../../src/lib/remote-protocol"
import type { DeviceView } from "../../src/lib/remote-view"
import { isPermission } from "../../src/lib/remote-protocol"

export const FILE_VERSION = 1
export const LOCK_AFTER_MS = 24 * 3600_000
export const EXPIRE_AFTER_MS = 30 * 24 * 3600_000
export const PENDING_MS = 2 * 60_000
export const PENDING_WINDOW_MS = 10 * 60_000
export const PENDING_PER_WINDOW = 3
export const PIN_TRIES_PER_DEVICE = 5
export const PIN_TRIES_PER_HOUR = 10
export const PIN_MIN_DIGITS = 6
const CODE_ALPHABET = "ACDEFGHJKMNPQRTUVWXY34679" // no 0/O, 1/I/L, 2/Z, 5/S, 8/B

export interface Device {
  id: string
  nodeId: string
  name: string
  permission: Permission
  tokenHash: string
  addedAt: number
  lastSeen: number
  pinFails: number
  machine?: true // another minmux (it types in terminals: "keys" when allowed)
}

export type { DeviceView }

export type AuthResult =
  | { state: "ok"; device: DeviceView }
  | { state: "locked"; device: DeviceView; pin: boolean }
  | { state: "none" }

/** The desktop's answer: a permission, "allow" for the usual one, or "deny". */
export type Decision = Permission | "allow" | "deny"

export type SetPinResult = "ok" | "invalid" | "readonly" | "error"

export type UnlockResult = "ok" | "wrong" | "blocked" | "disabled" | "no-pin" | "unknown"

interface Pending {
  id: string
  nodeId: string
  name: string
  code: string
  at: number
  machine?: boolean
  decision?: Decision
  token?: string // set on approval, handed out once
  deviceId?: string // the device the approval created
  taken?: boolean
}

interface Pin {
  salt: string
  hash: string
}

interface FileShape {
  v: number
  devices: Device[]
  pin?: Pin
  pinDisabled?: boolean
}

export interface DeviceTableOptions {
  now?: () => number
  random?: (n: number) => Buffer
  /** Called after every change with the file's new contents (the caller writes it). */
  save: (contents: string) => void
  /** scrypt, injectable so tests stay fast. */
  derive?: (pin: string, salt: string) => Promise<string>
}

const sha256 = (s: string) => crypto.createHash("sha256").update(s).digest("hex")

const scrypt = (pin: string, salt: string): Promise<string> =>
  new Promise((resolve, reject) =>
    crypto.scrypt(
      pin,
      salt,
      32,
      { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 },
      (err, key) => (err ? reject(err) : resolve(key.toString("hex"))),
    ),
  )

/** Parses the file; `newer` when a later build wrote it (then it's never overwritten). */
export function parseDeviceFile(raw: string | null): { file: FileShape; newer: boolean } {
  const empty = { file: { v: FILE_VERSION, devices: [] }, newer: false }
  if (!raw) return empty
  let o: Partial<FileShape>
  try {
    o = JSON.parse(raw) as Partial<FileShape>
  } catch {
    return empty
  }
  if (!o || typeof o !== "object") return empty
  if (typeof o.v === "number" && o.v > FILE_VERSION)
    return { file: { v: o.v, devices: [] }, newer: true }
  const devices = Array.isArray(o.devices)
    ? o.devices
        .filter(
          (d): d is Device =>
            !!d &&
            typeof d.id === "string" &&
            typeof d.nodeId === "string" &&
            typeof d.name === "string" &&
            isPermission(d.permission) &&
            typeof d.tokenHash === "string" &&
            typeof d.addedAt === "number" &&
            typeof d.lastSeen === "number",
        )
        .map((d) => ({ ...d, pinFails: typeof d.pinFails === "number" ? d.pinFails : 0 }))
    : []
  const pin =
    o.pin && typeof o.pin.salt === "string" && typeof o.pin.hash === "string" ? o.pin : undefined
  return {
    file: { v: FILE_VERSION, devices, pin, pinDisabled: o.pinDisabled === true },
    newer: false,
  }
}

/** The device table: approvals, tokens, the idle lock and the PIN. */
export class DeviceTable {
  private devices: Device[]
  private pin?: Pin
  private pinDisabled: boolean
  private readonly readOnly: boolean
  private pending = new Map<string, Pending>()
  private pendingLog: { nodeId: string; at: number }[] = []
  private pinFailLog: number[] = []
  private savedAt = new Map<string, number>() // per device: when its lastSeen was last saved
  private unlocking: Promise<unknown> = Promise.resolve() // one PIN check at a time
  private now: () => number
  private random: (n: number) => Buffer
  private derive: (pin: string, salt: string) => Promise<string>

  constructor(
    raw: string | null,
    private readonly opts: DeviceTableOptions,
  ) {
    const { file, newer } = parseDeviceFile(raw)
    this.devices = file.devices
    this.pin = file.pin
    this.pinDisabled = !!file.pinDisabled
    this.readOnly = newer
    this.now = opts.now ?? Date.now
    this.random = opts.random ?? ((n) => crypto.randomBytes(n))
    this.derive = opts.derive ?? scrypt
    this.sweep()
  }

  /** A newer build's file: nothing can be approved or changed (it's never overwritten). */
  get newerFile(): boolean {
    return this.readOnly
  }

  get hasPin(): boolean {
    return !!this.pin
  }

  get pinUnlockOff(): boolean {
    return this.pinDisabled
  }

  list(): DeviceView[] {
    this.sweep()
    return this.devices.map((d) => this.view(d))
  }

  /** Starts an approval for a node (or returns the one already pending for it). */
  createPending(
    nodeId: string,
    name: string,
    machine = false,
  ): { id: string; code: string; existing?: boolean } | "limited" | "readonly" {
    if (this.readOnly) return "readonly"
    const now = this.now()
    this.dropOldPending(now)
    // Already asking for this node (a second tab, a reload): the same prompt and code.
    for (const p of this.pending.values())
      // (Not another minmux's: two of them can run on one computer, an installed and a dev
      // build, and each collects its own token. A minmux asks once at a time itself.)
      if (p.nodeId === nodeId && !p.decision && !machine && !p.machine)
        return { id: p.id, code: p.code, existing: true }
    this.pendingLog = this.pendingLog.filter((e) => now - e.at < PENDING_WINDOW_MS)
    if (this.pendingLog.filter((e) => e.nodeId === nodeId).length >= PENDING_PER_WINDOW)
      return "limited"
    this.pendingLog.push({ nodeId, at: now })
    const id = this.random(16).toString("hex")
    const bytes = this.random(4)
    const code = [...bytes].map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join("")
    this.pending.set(id, { id, nodeId, name, code, at: now, ...(machine ? { machine } : {}) })
    return { id, code }
  }

  /** The desktop's answer to an approval prompt. False when it expired meanwhile. */
  decide(pendingId: string, decision: Decision): boolean {
    const now = this.now()
    this.dropOldPending(now)
    const p = this.pending.get(pendingId)
    if (!p || p.decision) return false
    p.decision = decision
    if (decision === "deny") return true
    const token = this.random(32).toString("base64url")
    // Approving a node again replaces its locked entries (asked again from the Locked screen).
    this.devices = this.devices.filter((d) => !(d.nodeId === p.nodeId && this.isLocked(d)))
    const base = p.name || "device"
    const taken = new Set(this.devices.map((d) => d.name))
    let name = base
    for (let i = 2; taken.has(name); i++) name = `${base} (${i})`
    const id = this.random(8).toString("hex")
    this.devices.push({
      id,
      nodeId: p.nodeId,
      name,
      // Allow: the usual permission (another minmux opens terminals: it types in them).
      permission: decision === "allow" ? (p.machine ? "keys" : "send") : decision,
      ...(p.machine ? { machine: true as const } : {}),
      tokenHash: sha256(token),
      addedAt: now,
      lastSeen: now,
      pinFails: 0,
    })
    p.token = token
    p.deviceId = id
    p.at = now // the page gets the full window to collect it
    this.persist()
    return true
  }

  /** Polled by the waiting page. The token is handed out once, to the node it was issued for. */
  pendingState(
    pendingId: string,
    nodeId: string,
  ):
    | { state: "pending"; code: string }
    | { state: "approved"; token: string }
    | { state: "denied" }
    | { state: "expired" } {
    this.dropOldPending(this.now())
    const p = this.pending.get(pendingId)
    if (!p || p.nodeId !== nodeId || p.taken) return { state: "expired" }
    if (!p.decision) return { state: "pending", code: p.code }
    if (p.decision === "deny") {
      this.pending.delete(pendingId)
      return { state: "denied" }
    }
    p.taken = true
    this.pending.delete(pendingId)
    return { state: "approved", token: p.token! }
  }

  /** The prompt's details (for the dialog), while it's still pending. */
  pendingInfo(pendingId: string): { name: string; code: string } | null {
    const p = this.pending.get(pendingId)
    return p && !p.decision ? { name: p.name, code: p.code } : null
  }

  /** Who a token is, from the node it must have been issued to. */
  auth(token: string | null, nodeId: string): AuthResult {
    this.sweep()
    const d = this.find(token, nodeId)
    if (!d) return { state: "none" }
    if (this.isLocked(d))
      return { state: "locked", device: this.view(d), pin: this.canUnlockByPin() }
    return { state: "ok", device: this.view(d) }
  }

  /** Activity from a device: keeps it unlocked. Never unlocks a locked one. */
  touch(deviceId: string): void {
    const d = this.devices.find((x) => x.id === deviceId)
    if (!d || this.isLocked(d)) return
    const now = this.now()
    d.lastSeen = now
    // Saved at most once a minute (lastSeen only matters at hour scale), counted from the last save.
    if (now - (this.savedAt.get(d.id) ?? 0) >= 60_000) {
      this.savedAt.set(d.id, now)
      this.persist()
    }
  }

  /** Lifts the idle lock with the PIN. Wrong PINs count per device and per hour overall. */
  unlock(token: string | null, nodeId: string, pin: string): Promise<UnlockResult> {
    // One at a time: parallel guesses can't slip past the hourly limit while scrypt runs.
    const run = this.unlocking.then(() => this.unlockOne(token, nodeId, pin))
    this.unlocking = run.catch(() => {})
    return run
  }

  private async unlockOne(
    token: string | null,
    nodeId: string,
    pin: string,
  ): Promise<UnlockResult> {
    const d = this.find(token, nodeId)
    if (!d) return "unknown"
    if (!this.pin) return "no-pin"
    if (this.pinDisabled) return "disabled"
    const now = this.now()
    this.pinFailLog = this.pinFailLog.filter((t) => now - t < 3600_000)
    const hash = await this.derive(pin, this.pin.salt)
    // The device may have been revoked while scrypt ran.
    if (!this.devices.includes(d)) return "unknown"
    if (this.pinDisabled) return "disabled"
    const a = Buffer.from(hash, "hex")
    const b = Buffer.from(this.pin.hash, "hex")
    const ok = a.length === b.length && crypto.timingSafeEqual(a, b)
    if (ok) {
      d.pinFails = 0
      d.lastSeen = this.now()
      this.persist()
      return "ok"
    }
    d.pinFails++
    this.pinFailLog.push(now)
    if (this.pinFailLog.length >= PIN_TRIES_PER_HOUR) this.pinDisabled = true
    if (d.pinFails >= PIN_TRIES_PER_DEVICE) {
      this.devices = this.devices.filter((x) => x !== d)
      this.persist()
      return "blocked"
    }
    this.persist()
    return this.pinDisabled ? "disabled" : "wrong"
  }

  /** Sets (or replaces) the PIN; also turns PIN unlocking back on. */
  async setPin(pin: string): Promise<SetPinResult> {
    if (this.readOnly) return "readonly"
    if (!new RegExp(`^\\d{${PIN_MIN_DIGITS},32}$`).test(pin)) return "invalid"
    const salt = this.random(16).toString("hex")
    this.pin = { salt, hash: await this.derive(pin, salt) }
    this.pinDisabled = false
    this.pinFailLog = []
    this.persist()
    return "ok"
  }

  revoke(id: string): boolean {
    const before = this.devices.length
    this.devices = this.devices.filter((d) => d.id !== id)
    if (this.devices.length === before) return false
    this.persist()
    return true
  }

  rename(id: string, name: string): boolean {
    const d = this.devices.find((x) => x.id === id)
    const clean = name.trim().slice(0, 40)
    if (!d || !clean) return false
    d.name = clean
    this.persist()
    return true
  }

  setPermission(id: string, permission: Permission): boolean {
    const d = this.devices.find((x) => x.id === id)
    if (!d || !isPermission(permission)) return false
    d.permission = permission
    this.persist()
    return true
  }

  /** The device's current permission (main's check before every write). */
  permissionOf(id: string): Permission | null {
    const d = this.devices.find((x) => x.id === id)
    return d && !this.isLocked(d) ? d.permission : null
  }

  /** Removes devices unused for 30 days. */
  sweep(): void {
    const now = this.now()
    this.dropOldPending(now) // an approval nobody collected takes its device with it
    const keep = this.devices.filter((d) => now - d.lastSeen < EXPIRE_AFTER_MS)
    if (keep.length !== this.devices.length) {
      this.devices = keep
      this.persist()
    }
  }

  private find(token: string | null, nodeId: string): Device | undefined {
    if (!token) return undefined
    const h = sha256(token)
    return this.devices.find((d) => d.tokenHash === h && d.nodeId === nodeId)
  }

  private isLocked(d: Device): boolean {
    return this.now() - d.lastSeen >= LOCK_AFTER_MS
  }

  private canUnlockByPin(): boolean {
    return !!this.pin && !this.pinDisabled
  }

  private view(d: Device): DeviceView {
    return {
      id: d.id,
      name: d.name,
      permission: d.permission,
      addedAt: d.addedAt,
      lastSeen: d.lastSeen,
      locked: this.isLocked(d),
    }
  }

  /** Drops expired prompts; an approval whose page never came back takes its device with it. */
  private dropOldPending(now: number): void {
    for (const [id, p] of this.pending) {
      if (now - p.at < PENDING_MS) continue
      this.pending.delete(id)
      if (p.deviceId && !p.taken) this.revoke(p.deviceId)
    }
  }

  private persist(): void {
    if (this.readOnly) return
    const file: FileShape = {
      v: FILE_VERSION,
      devices: this.devices,
      pin: this.pin,
      pinDisabled: this.pinDisabled,
    }
    this.opts.save(JSON.stringify(file, null, 2))
  }
}
