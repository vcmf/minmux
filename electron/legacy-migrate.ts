// One-time carry-over from the app's old name (smterm → minmux). An existing install keeps its
// settings, layout, resume ledger and localStorage: a profile's first minmux launch COPIES
// those few entries from its old smterm dirs (never moves them, so an older build still finds
// its own). Only named state is copied — caches, locks and per-launch hook files rebuild
// themselves — and each entry on its own, so one locked file never costs the rest. Best-effort
// and never throws: whatever fails is reported, and startup goes on fresh for that entry. Runs
// only while no smterm is running: its live ledger would resume its Claude sessions twice.

import fs from "node:fs"
import path from "node:path"

/** What's worth carrying: the config dir's state files + the user-data dir's localStorage. */
export const LEGACY_ENTRIES = [
  "settings.json",
  "workspace.json",
  "agent-sessions.json",
  "window-bg",
  "Local Storage",
]

// Written into the new dir after the attempt (or a "start without them"): later launches skip it.
export const MIGRATED_MARKER = ".migrated-from-smterm"

export interface MigrateResult {
  copied: string[] // new-dir paths written
  failed: string[] // "<path>: <error>" — that entry starts fresh
}

/** The pairs with an old dir to carry: none once marked, or when there's no old dir. */
export function pendingLegacyDirs(
  pairs: readonly (readonly [to: string, from: string])[],
): (readonly [to: string, from: string])[] {
  return pairs.filter(
    ([to, from]) =>
      from !== to && fs.existsSync(from) && !fs.existsSync(path.join(to, MIGRATED_MARKER)),
  )
}

/** Whether an smterm holds its single-instance lock in `userData` (Chromium's SingletonLock
 *  symlink → "<host>-<pid>" on macOS / Linux; an exclusively opened `lockfile` on Windows). */
export function legacyInstanceRunning(
  userData: string,
  alive: (pid: number) => boolean = pidAlive,
): boolean {
  try {
    const target = fs.readlinkSync(path.join(userData, "SingletonLock"))
    const pid = Number(target.slice(target.lastIndexOf("-") + 1))
    return Number.isInteger(pid) && pid > 0 && alive(pid)
  } catch {
    // no lock symlink: not running (macOS / Linux), or Windows — try its lockfile
  }
  const lockfile = path.join(userData, "lockfile")
  if (process.platform !== "win32" || !fs.existsSync(lockfile)) return false
  try {
    fs.closeSync(fs.openSync(lockfile, "r+"))
    return false
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EBUSY"
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM" // alive, just not ours
  }
}

/** Mark each dir done without copying ("start without them"): later launches don't ask. */
export function markLegacyDirs(pairs: readonly (readonly [to: string, from: string])[]): void {
  for (const [to, from] of pairs) mark(to, from, { copied: [], failed: [] })
}

/** Copy LEGACY_ENTRIES from each [to, from] dir pair where the new dir lacks them. */
export function migrateLegacyDirs(
  pairs: readonly (readonly [to: string, from: string])[],
): MigrateResult {
  const res: MigrateResult = { copied: [], failed: [] }
  for (const [to, from] of pendingLegacyDirs(pairs)) {
    for (const name of LEGACY_ENTRIES) copyEntry(path.join(from, name), path.join(to, name), res)
    mark(to, from, res)
  }
  return res
}

function mark(to: string, from: string, res: MigrateResult): void {
  try {
    fs.mkdirSync(to, { recursive: true })
    fs.writeFileSync(path.join(to, MIGRATED_MARKER), `${from}\n`)
  } catch (err) {
    res.failed.push(`${path.join(to, MIGRATED_MARKER)}: ${String(err)}`)
  }
}

// Staged in a sibling and renamed into place: a crash mid-copy never leaves a half entry.
function copyEntry(src: string, dst: string, res: MigrateResult): void {
  if (!fs.existsSync(src) || fs.existsSync(dst)) return
  const tmp = `${dst}.migrating`
  try {
    fs.rmSync(tmp, { recursive: true, force: true }) // a killed earlier launch's leftover
    fs.mkdirSync(path.dirname(dst), { recursive: true })
    fs.cpSync(src, tmp, { recursive: true, verbatimSymlinks: true })
    fs.renameSync(tmp, dst)
    res.copied.push(dst)
  } catch (err) {
    res.failed.push(`${dst}: ${String(err)}`)
    try {
      fs.rmSync(tmp, { recursive: true, force: true })
    } catch {
      // still locked (Windows): a stray temp copy, harmless
    }
  }
}
