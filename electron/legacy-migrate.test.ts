import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { copyLegacyDir, legacyAppName, migrateLegacyDirs } from "./legacy-migrate"

describe("legacyAppName", () => {
  it("maps each profile's name to its smterm one", () => {
    expect(legacyAppName("minmux")).toBe("smterm")
    expect(legacyAppName("minmux-dev")).toBe("smterm-dev")
    expect(legacyAppName("minmux-e2e-1")).toBe("smterm-e2e-1")
  })
  it("has none for a name it didn't make", () => {
    expect(legacyAppName("other")).toBeNull()
    expect(legacyAppName("minmuxdev")).toBeNull()
  })
})

describe("copyLegacyDir", () => {
  let root: string
  const at = (...p: string[]) => path.join(root, ...p)
  const write = (p: string, body = "x") => {
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, body)
  }
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-migrate-"))
  })
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

  it("copies the old dir (settings, layout, localStorage) and leaves it in place", () => {
    write(at("smterm", "settings.json"), '{"theme":"x"}')
    write(at("smterm", "workspace.json"), "{}")
    write(at("smterm", "Local Storage", "leveldb", "000003.log"), "ls")
    expect(copyLegacyDir(at("smterm"), at("minmux"))).toBe(true)
    expect(fs.readFileSync(at("minmux", "settings.json"), "utf8")).toBe('{"theme":"x"}')
    expect(fs.existsSync(at("minmux", "workspace.json"))).toBe(true)
    expect(fs.existsSync(at("minmux", "Local Storage", "leveldb", "000003.log"))).toBe(true)
    expect(fs.existsSync(at("smterm", "settings.json"))).toBe(true) // an older build still reads it
    expect(fs.readdirSync(root).sort()).toEqual(["minmux", "smterm"]) // no temp dir left
  })

  it("skips caches, the instance lock and per-launch hook state", () => {
    write(at("smterm", "settings.json"))
    write(at("smterm", "GPUCache", "data_0"))
    write(at("smterm", "Code Cache", "js", "index"))
    write(at("smterm", "hook-events", "abc", "e1.json"))
    write(at("smterm", "claude-hooks.json"))
    write(at("smterm", "sub", "Cache", "kept")) // only top-level entries are skipped
    if (process.platform !== "win32") fs.symlinkSync("host-123", at("smterm", "SingletonLock"))
    expect(copyLegacyDir(at("smterm"), at("minmux"))).toBe(true)
    expect(fs.readdirSync(at("minmux")).sort()).toEqual(["settings.json", "sub"])
    expect(fs.existsSync(at("minmux", "sub", "Cache", "kept"))).toBe(true)
  })

  it("never touches a new dir that already exists", () => {
    write(at("smterm", "settings.json"), "old")
    write(at("minmux", "settings.json"), "new")
    expect(copyLegacyDir(at("smterm"), at("minmux"))).toBe(false)
    expect(fs.readFileSync(at("minmux", "settings.json"), "utf8")).toBe("new")
  })

  it("does nothing when there's no old dir", () => {
    expect(copyLegacyDir(at("smterm"), at("minmux"))).toBe(false)
    expect(fs.existsSync(at("minmux"))).toBe(false)
  })

  it("copies a dir listed twice (config = user data on Linux / Windows) once", () => {
    write(at("smterm", "settings.json"))
    expect(
      migrateLegacyDirs([
        [at("minmux"), at("smterm")],
        [at("minmux"), at("smterm")],
      ]),
    ).toEqual([at("minmux")])
  })
})
