import fs from "node:fs"
import path from "node:path"

// Lightweight, always-on event log for the session-survival investigation: app
// lifecycle + macOS power events + PTY spawn/exit, appended to a file that OUTLIVES
// the app process. If the OS terminates minmux on lid-close, the old instance's
// last lines + a fresh `boot` with a new pid (and NO `before-quit`/`quit` between)
// prove it was killed rather than suspended. Events are rare, so the file stays tiny.

/** One line: ISO timestamp + event + space-joined key=value fields. Pure — tested. */
export function formatDiagLine(
  iso: string,
  event: string,
  fields: Record<string, string | number | boolean> = {},
): string {
  const kv = Object.entries(fields)
    .map(([k, v]) => `${k}=${v}`)
    .join(" ")
  return kv ? `${iso} ${event} ${kv}` : `${iso} ${event}`
}

/** Append a diagnostics line to `dir/diagnostics.log` (best-effort, never throws). */
export function appendDiag(
  dir: string,
  event: string,
  fields?: Record<string, string | number | boolean>,
): void {
  try {
    fs.mkdirSync(dir, { recursive: true })
    fs.appendFileSync(
      path.join(dir, "diagnostics.log"),
      `${formatDiagLine(new Date().toISOString(), event, fields)}\n`,
    )
  } catch {
    // diagnostics must never break the app
  }
}
