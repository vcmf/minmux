// One-time carry-over from the app's old name (smterm → minmux). An existing install keeps its
// settings, layout, resume ledger and localStorage: a profile's first minmux launch COPIES
// those few entries from its old smterm dirs (never moves them, so an older build still finds
// its own). Only named state is copied — caches, locks and per-launch hook files rebuild
// themselves — and each entry on its own, so one locked file never costs the rest. Best-effort
// and never throws: whatever fails is reported, and startup goes on fresh for that entry.

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

// Written into the new dir once its entries all copied (or were already there): later launches
// skip it. A failed entry leaves it unmarked, to retry next launch — never over a newer file.
export const MIGRATED_MARKER = ".migrated-from-smterm"

export interface MigrateResult {
  copied: string[] // new-dir paths written
  failed: string[] // "<path>: <error>" — this launch starts fresh for it
}

/** Copy LEGACY_ENTRIES from each [to, from] dir pair where the new dir lacks them. */
export function migrateLegacyDirs(
  pairs: readonly (readonly [to: string, from: string])[],
): MigrateResult {
  const res: MigrateResult = { copied: [], failed: [] }
  for (const [to, from] of pairs) {
    if (from === to || !fs.existsSync(from) || fs.existsSync(path.join(to, MIGRATED_MARKER))) {
      continue
    }
    const before = res.failed.length
    for (const name of LEGACY_ENTRIES) copyEntry(path.join(from, name), path.join(to, name), res)
    if (res.failed.length > before) continue
    try {
      fs.mkdirSync(to, { recursive: true })
      fs.writeFileSync(path.join(to, MIGRATED_MARKER), `${from}\n`)
    } catch (err) {
      res.failed.push(`${path.join(to, MIGRATED_MARKER)}: ${String(err)}`)
    }
  }
  return res
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
      // still locked (Windows) — the next attempt's rmSync clears it
    }
  }
}
