// Pure mapping from a repo's changed-file list to per-path git decorations for the
// file browser: which files changed (+ status) and which folders contain changes
// (status rolled up to every ancestor, aggregated by severity). No React, no IPC.

import type { ChangeStatus, GitFile } from "./ipc"
import { joinPath } from "./file-tree"

export interface GitDecorations {
  file: Map<string, ChangeStatus> // absolute file path → its status
  dir: Map<string, ChangeStatus> // absolute folder path → most-severe status inside it
  untrackedDirs: string[] // wholly-untracked folders (git reports each once): all inside is "?"
}

// Folder aggregate severity, low → high. A folder shows the most severe change it
// contains: deleted > modified > renamed > added > untracked.
const SEVERITY: ChangeStatus[] = ["?", "A", "R", "M", "D"]
const moreSevere = (a: ChangeStatus, b: ChangeStatus) =>
  SEVERITY.indexOf(a) >= SEVERITY.indexOf(b) ? a : b

const parentDir = (p: string) => {
  const i = p.lastIndexOf("/")
  return i <= 0 ? "/" : p.slice(0, i)
}

/** Build decorations. `files` come with repo-root-relative paths (git porcelain), so
 *  `repoRoot` resolves them to absolute — matching the browser's absolute tree paths.
 *  Folders get every changed descendant rolled up (aggregated by severity), stopping
 *  at repoRoot. Empty repoRoot → empty (not a repo). Pure. */
export function buildGitDecorations(repoRoot: string, files: GitFile[]): GitDecorations {
  const file = new Map<string, ChangeStatus>()
  const dir = new Map<string, ChangeStatus>()
  const untrackedDirs: string[] = []
  if (!repoRoot) return { file, dir, untrackedDirs }
  for (const f of files) {
    const abs = joinPath(repoRoot, f.path)
    if (f.isDir) {
      untrackedDirs.push(abs)
      dir.set(abs, f.status) // the folder itself is untracked…
    } else file.set(abs, f.status)
    // Roll the status up through ancestor folders, up to and including repoRoot.
    let d = parentDir(abs)
    while (d === repoRoot || d.startsWith(`${repoRoot}/`)) {
      const cur = dir.get(d)
      dir.set(d, cur ? moreSevere(cur, f.status) : f.status)
      if (d === repoRoot) break
      d = parentDir(d)
    }
  }
  return { file, dir, untrackedDirs }
}

/** A path's badge: its own status, else "?" when it sits inside a wholly-untracked folder. */
export function statusAt(
  deco: GitDecorations,
  abs: string,
  isDir: boolean,
): ChangeStatus | undefined {
  const own = isDir ? deco.dir.get(abs) : deco.file.get(abs)
  if (own) return own
  return deco.untrackedDirs.some((d) => abs.startsWith(`${d}/`)) ? "?" : undefined
}

/** Single-letter badge for a status (untracked shows as U). */
export const statusLetter = (s: ChangeStatus): string => (s === "?" ? "U" : s)

/** CSS color (theme var) for a status — shared by the file badge + folder tint. */
export function statusColor(s: ChangeStatus): string {
  switch (s) {
    case "M":
      return "var(--amber)"
    case "A":
    case "?":
      return "var(--accent)"
    case "D":
      return "var(--red)"
    case "R":
      return "var(--blue)"
    default:
      return "var(--dim)" // a future status (C/T…) decorates neutrally, never undefined
  }
}
