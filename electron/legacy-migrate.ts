// One-time carry-over from the app's old name (smterm → minmux). An existing install keeps its
// settings, layout, resume ledger and localStorage: on the first minmux launch of a profile,
// the old profile's config and user-data dirs are COPIED to the new names (never moved, so an
// older smterm build still finds its own). Chromium caches and per-run state are skipped —
// they rebuild themselves. Best-effort: any failure just starts fresh, never blocks startup.

import fs from "node:fs"
import path from "node:path"

const LEGACY_NAME = "smterm"
const NAME = "minmux"

/** The old app name for a profile's `appName`: "minmux" → "smterm", "minmux-dev" → "smterm-dev". */
export function legacyAppName(appName: string): string | null {
  if (appName === NAME) return LEGACY_NAME
  if (appName.startsWith(`${NAME}-`)) return LEGACY_NAME + appName.slice(NAME.length)
  return null
}

// Top-level entries not worth carrying: Chromium caches, crash dumps, the single-instance
// lock (Linux symlinks / Windows lockfile — copying one would confuse the new lock) and the
// per-launch hook drop dir + scoped hook settings, which startup rewrites anyway.
const SKIP = new Set([
  "Cache",
  "Code Cache",
  "GPUCache",
  "DawnCache",
  "DawnGraphiteCache",
  "DawnWebGPUCache",
  "GrShaderCache",
  "ShaderCache",
  "Crashpad",
  "blob_storage",
  "Service Worker",
  "SingletonLock",
  "SingletonCookie",
  "SingletonSocket",
  "lockfile",
  "hook-events",
  "claude-hooks.json",
  "claude-hooks.wsl.json",
])

/** Copy `from` to `to` when only `from` exists (true = copied). Staged in a temp sibling and
 *  renamed into place, so a crash mid-copy never leaves a half dir that blocks a retry. */
export function copyLegacyDir(from: string, to: string): boolean {
  if (from === to || fs.existsSync(to) || !fs.existsSync(from)) return false
  const tmp = `${to}.migrating-${process.pid}`
  try {
    fs.rmSync(tmp, { recursive: true, force: true })
    fs.cpSync(from, tmp, {
      recursive: true,
      verbatimSymlinks: true,
      filter: (src) => path.dirname(src) !== from || !SKIP.has(path.basename(src)),
    })
    fs.renameSync(tmp, to)
    return true
  } catch {
    fs.rmSync(tmp, { recursive: true, force: true }) // a racing launch won, or the copy failed
    return false
  }
}

/** Carry each old-named dir over to its new name; returns the dirs that were copied. The dirs
 *  are given as [new, old] pairs; the same dir twice (Linux / Windows: config = user data) is
 *  copied once. */
export function migrateLegacyDirs(pairs: [to: string, from: string][]): string[] {
  return pairs.filter(([to, from]) => copyLegacyDir(from, to)).map(([to]) => to)
}
