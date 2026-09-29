import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  legacyInstanceRunning,
  markLegacyDirs,
  MIGRATED_MARKER,
  migrateLegacyDirs,
  pendingLegacyDirs,
} from "./legacy-migrate"

describe("migrateLegacyDirs", () => {
  let root: string
  const at = (...p: string[]) => path.join(root, ...p)
  const write = (p: string, body = "x") => {
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, body)
  }
  const read = (p: string) => fs.readFileSync(p, "utf8")
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-migrate-"))
  })
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

  it("copies the old state (settings, layout, ledger, localStorage) and leaves it in place", () => {
    write(at("smterm", "settings.json"), '{"theme":"x"}')
    write(at("smterm", "workspace.json"), "{}")
    write(at("smterm", "agent-sessions.json"), "[]")
    write(at("smterm", "Local Storage", "leveldb", "000003.log"), "ls")
    const r = migrateLegacyDirs([[at("minmux"), at("smterm")]])
    expect(r.failed).toEqual([])
    expect(read(at("minmux", "settings.json"))).toBe('{"theme":"x"}')
    expect(read(at("minmux", "Local Storage", "leveldb", "000003.log"))).toBe("ls")
    expect(r.copied).toHaveLength(4)
    expect(read(at("smterm", "settings.json"))).toBe('{"theme":"x"}') // an older build still reads it
  })

  it("carries only named state — no caches, locks or per-launch hook files", () => {
    write(at("smterm", "settings.json"))
    write(at("smterm", "GPUCache", "data_0"))
    write(at("smterm", "hook-events", "abc", "e1.json"))
    write(at("smterm", "claude-hooks.json"))
    if (process.platform !== "win32") fs.symlinkSync("host-123", at("smterm", "SingletonLock"))
    migrateLegacyDirs([[at("minmux"), at("smterm")]])
    expect(fs.readdirSync(at("minmux")).sort()).toEqual([MIGRATED_MARKER, "settings.json"])
  })

  it("fills a new dir that already exists (e.g. Electron made it) without overwriting its files", () => {
    write(at("smterm", "settings.json"), "old")
    write(at("smterm", "workspace.json"), "old layout")
    write(at("minmux", "settings.json"), "new")
    write(at("minmux", "Crashpad", "x"))
    migrateLegacyDirs([[at("minmux"), at("smterm")]])
    expect(read(at("minmux", "settings.json"))).toBe("new")
    expect(read(at("minmux", "workspace.json"))).toBe("old layout")
  })

  it("runs once: a marked dir is left alone on later launches", () => {
    write(at("smterm", "settings.json"), "old")
    migrateLegacyDirs([[at("minmux"), at("smterm")]])
    fs.rmSync(at("minmux", "settings.json")) // the user reset their settings since
    expect(migrateLegacyDirs([[at("minmux"), at("smterm")]]).copied).toEqual([])
    expect(fs.existsSync(at("minmux", "settings.json"))).toBe(false)
  })

  it("clears a killed launch's half-copied temp entry and copies it again", () => {
    write(at("smterm", "workspace.json"), "w")
    write(at("minmux", "workspace.json.migrating", "partial"), "killed mid-copy")
    expect(migrateLegacyDirs([[at("minmux"), at("smterm")]]).failed).toEqual([])
    expect(read(at("minmux", "workspace.json"))).toBe("w")
    expect(fs.existsSync(at("minmux", "workspace.json.migrating"))).toBe(false)
  })

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "keeps going past an entry it can't read, and reports it",
    () => {
      write(at("smterm", "settings.json"), "s")
      write(at("smterm", "workspace.json"), "w")
      fs.chmodSync(at("smterm", "settings.json"), 0o000) // as a file locked by another process
      const r = migrateLegacyDirs([[at("minmux"), at("smterm")]])
      fs.chmodSync(at("smterm", "settings.json"), 0o644)
      expect(r.failed).toHaveLength(1)
      expect(read(at("minmux", "workspace.json"))).toBe("w")
      expect(fs.existsSync(at("minmux", "settings.json.migrating"))).toBe(false)
    },
  )

  it("reports a failure instead of throwing, and doesn't mark the dir", () => {
    write(at("smterm", "settings.json"), "s")
    write(at("minmux"), "a file where the dir should be") // every write under it fails
    const r = migrateLegacyDirs([[at("minmux"), at("smterm")]])
    expect(r.copied).toEqual([])
    expect(r.failed.length).toBeGreaterThan(0)
  })

  it("does nothing without an old dir, and handles one dir listed twice once", () => {
    expect(migrateLegacyDirs([[at("minmux"), at("smterm")]])).toEqual({ copied: [], failed: [] })
    expect(fs.existsSync(at("minmux"))).toBe(false)
    write(at("smterm", "settings.json"))
    const r = migrateLegacyDirs([
      [at("minmux"), at("smterm")], // Linux / Windows: config dir = user-data dir
      [at("minmux"), at("smterm")],
    ])
    expect(r.copied).toEqual([at("minmux", "settings.json")])
  })

  it("lists only the dirs still to carry, and a declined one stops being asked about", () => {
    write(at("smterm", "settings.json"))
    const pairs = [[at("minmux"), at("smterm")] as const, [at("x"), at("gone")] as const]
    expect(pendingLegacyDirs(pairs)).toEqual([pairs[0]])
    markLegacyDirs(pendingLegacyDirs(pairs))
    expect(pendingLegacyDirs(pairs)).toEqual([])
    expect(fs.existsSync(at("minmux", "settings.json"))).toBe(false) // declined: nothing copied
  })

  it.skipIf(process.platform === "win32")("sees a running smterm by its SingletonLock", () => {
    fs.mkdirSync(at("smterm"))
    expect(legacyInstanceRunning(at("smterm"))).toBe(false) // no lock
    fs.symlinkSync("my-mac.local-4242", at("smterm", "SingletonLock"))
    expect(legacyInstanceRunning(at("smterm"), (pid) => pid === 4242)).toBe(true)
    expect(legacyInstanceRunning(at("smterm"), () => false)).toBe(false) // stale lock
    fs.rmSync(at("smterm", "SingletonLock"))
    fs.symlinkSync(`host-${process.pid}`, at("smterm", "SingletonLock"))
    expect(legacyInstanceRunning(at("smterm"))).toBe(true) // the real liveness check
  })
})
