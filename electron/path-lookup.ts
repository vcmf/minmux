// Finding commands on PATH (main's PATH: the login shell's, imported at startup by
// shell-env.ts). Sync, for quick checks; main's ssh lookup has its own async scan.

import fs from "node:fs"
import path from "node:path"

// Where `cmd` could be on PATH (PATHEXT on Windows), in lookup order.
export function pathCandidates(cmd: string): string[] {
  if (path.isAbsolute(cmd)) return [cmd]
  const exts =
    process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""]
  const dirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean)
  return dirs.flatMap((d) => exts.map((ext) => path.join(d, cmd + ext)))
}

// A file's full path on PATH, or null (sync: for the editor detection's quick checks).
export function findOnPath(cmd: string): string | null {
  return (
    pathCandidates(cmd).find((p) => {
      try {
        return fs.statSync(p).isFile()
      } catch {
        return false
      }
    }) ?? null
  )
}
