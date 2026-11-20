// Git for one file or folder tab (docs/design/WORKDIR_OBJECTS.md, "Git in folder and file tabs"):
// its entry in its repo's status, the changed files under a folder, the Source view's change
// bars from a diff, and a highlighted diff put back together from its two sides. Pure.
import type { ChangeStatus, DiffLine, GitFile, GitStatus } from "./ipc"
import { joinPath } from "./file-tree"

/** `abs` relative to `root` (forward slashes, as git's paths), or undefined if outside it. */
export function relTo(root: string, abs: string): string | undefined {
  // A Windows drive letter in either case (git says C:, a link may say c:).
  const norm = (p: string) => p.replace(/\\/g, "/").replace(/^[A-Z]:/, (d) => d.toLowerCase())
  const r = norm(root.replace(/[\\/]+$/, ""))
  const a = norm(abs)
  return a.startsWith(`${r}/`) ? a.slice(r.length + 1) : undefined
}

/** The file's entry in its repo's status, if it changed. */
export function gitFileFor(git: GitStatus | undefined, abs: string): GitFile | undefined {
  if (!git?.isRepo) return undefined
  const rel = relTo(git.root, abs)
  return rel === undefined ? undefined : git.files.find((f) => !f.isDir && f.path === rel)
}

/** The changed files under `folder` (its whole repo's when it's the root), in git's order. */
export function changesUnder(git: GitStatus | undefined, folder: string): GitFile[] {
  if (!git?.isRepo) return []
  const atRoot = relTo(folder, `${git.root.replace(/[\\/]+$/, "")}/x`) === "x"
  return git.files.filter((f) => {
    if (atRoot) return true
    return relTo(folder, joinPath(git.root, f.path)) !== undefined
  })
}

/** Which view a file opens on: Diff from the changes list (a change git can diff), else Source. */
export function opensOnDiff(status: ChangeStatus | undefined, fromChanges: boolean): boolean {
  if (status === "D") return true // there's no file to show
  return fromChanges && status === "M"
}

// Not a new file (it's all change) nor a rename: git's status has no old path for the diff to
// pair it with, so it would read as all new.
/** Whether a file's tab offers Source / Diff. */
export const hasDiffToggle = (status: ChangeStatus | undefined): boolean => status === "M"

// Added, modified (an add next to a delete), and lines with deleted lines just above them.
/** The Source view's change bars, by new-side line number. */
export function changeBars(lines: DiffLine[]): Map<number, "add" | "mod" | "del"> {
  const out = new Map<number, "add" | "mod" | "del">()
  let i = 0
  while (i < lines.length) {
    if (lines[i]!.type !== "add" && lines[i]!.type !== "del") {
      i++
      continue
    }
    // One run of changes: its deletes and adds together.
    const run: DiffLine[] = []
    while (i < lines.length && (lines[i]!.type === "add" || lines[i]!.type === "del"))
      run.push(lines[i++]!)
    const adds = run.filter((l) => l.type === "add")
    const dels = run.length - adds.length
    adds.forEach((l, k) => l.newNo && out.set(l.newNo, k < dels ? "mod" : "add"))
    if (!adds.length) {
      const next = lines[i]?.newNo // nothing replaced them: mark the line they were above
      if (next && !out.has(next)) out.set(next, "del")
    }
  }
  return out
}

/** A diff's old and new sides, as texts (context on both), with each line's place in them. */
export function diffSides(lines: DiffLine[]): {
  old: string
  new: string
  at: { side: "old" | "new" | "hunk"; i: number }[]
} {
  const o: string[] = []
  const n: string[] = []
  const at = lines.map((l) => {
    if (l.type === "hunk") return { side: "hunk" as const, i: -1 }
    if (l.type === "del") return { side: "old" as const, i: o.push(l.text) - 1 }
    if (l.type === "add") return { side: "new" as const, i: n.push(l.text) - 1 }
    o.push(l.text)
    return { side: "new" as const, i: n.push(l.text) - 1 }
  })
  return { old: o.join("\n"), new: n.join("\n"), at }
}

/** Each diff line's highlighted HTML, from its side's highlighted lines (a hunk header: as is). */
export function assembleDiff(
  at: { side: "old" | "new" | "hunk"; i: number }[],
  oldHtml: string[],
  newHtml: string[],
  hunkHtml: (k: number) => string,
): string[] {
  return at.map((a, k) =>
    a.side === "hunk" ? hunkHtml(k) : ((a.side === "old" ? oldHtml : newHtml)[a.i] ?? ""),
  )
}
