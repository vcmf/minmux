import { execFile } from "node:child_process"
import { toDirListing, type DirListing } from "../src/lib/dir-listing"
import { promisify } from "node:util"
import fs from "node:fs"
import path from "node:path"

const exec = promisify(execFile)

export type ChangeStatus = "M" | "A" | "D" | "R" | "?"

export interface GitFile {
  path: string // repo-relative
  name: string // basename
  dir: string // parent dir (repo-relative)
  status: ChangeStatus
  add: number
  del: number
  isDir?: boolean // an untracked folder, reported once (git's default untracked mode)
}

export interface GitStatus {
  isRepo: boolean
  root: string // repo toplevel (abs); "" when not a repo. Resolves repo-relative file paths.
  branch: string
  ahead: number
  behind: number
  files: GitFile[]
  add: number // totals
  del: number
  total?: number // set when `files` was capped: how many changes there really are
}

export type DiffLineType = "add" | "del" | "context" | "hunk"

export interface DiffLine {
  type: DiffLineType
  text: string
  oldNo?: number
  newNo?: number
}

const empty: GitStatus = {
  isRepo: false,
  root: "",
  branch: "",
  ahead: 0,
  behind: 0,
  files: [],
  add: 0,
  del: 0,
}

/** Parse the `## ...` branch header line of `git status --porcelain -b`. */
export function parseBranchLine(line: string): { branch: string; ahead: number; behind: number } {
  // e.g. "## main...origin/main [ahead 2, behind 1]" | "## main" | "## HEAD (no branch)"
  const body = line.replace(/^## /, "")
  const branch = body.split(/\.\.\.| /)[0] ?? ""
  const ahead = /ahead (\d+)/.exec(body)?.[1]
  const behind = /behind (\d+)/.exec(body)?.[1]
  return { branch, ahead: ahead ? Number(ahead) : 0, behind: behind ? Number(behind) : 0 }
}

/** Reduce a porcelain-v1 XY status pair to one display status. */
export function statusOf(xy: string): ChangeStatus {
  if (xy === "??") return "?"
  const code = xy.replace(/ /g, "")
  if (code.includes("D")) return "D"
  if (code.includes("A")) return "A"
  if (code.includes("R")) return "R"
  return "M"
}

/** Parse `git diff --numstat HEAD` output → path → {add, del}. */
export function parseNumstat(out: string): Map<string, { add: number; del: number }> {
  const map = new Map<string, { add: number; del: number }>()
  for (const line of out.split("\n")) {
    if (!line.trim()) continue
    const [add, del, ...rest] = line.split("\t")
    let file = rest.join("\t")
    // Renames: "old => new" (each side quoted on its own) or "dir/{a => b}/f" — take the new
    // path; then unquote it like porcelain (", \\, control chars).
    const split = splitRename(file.replace(" => ", " -> "))
    if (split && !file.includes("{")) file = split[1]
    else if (file.includes(" => "))
      file = file.replace(/\{.*? => (.*?)\}/g, "$1").replace(/.* => /, "")
    file = unquotePath(file)
    map.set(file, { add: add === "-" ? 0 : Number(add), del: del === "-" ? 0 : Number(del) })
  }
  return map
}

/** Parse a unified `git diff` into renderable lines with gutter line numbers. */
export function parseDiff(out: string): DiffLine[] {
  const lines: DiffLine[] = []
  let oldNo = 0
  let newNo = 0
  for (const raw of out.split("\n")) {
    if (raw.startsWith("diff ") || raw.startsWith("index ")) continue
    if (raw.startsWith("--- ") || raw.startsWith("+++ ")) continue
    if (raw.startsWith("@@")) {
      const m = /@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw)
      if (m) {
        oldNo = Number(m[1])
        newNo = Number(m[2])
      }
      lines.push({ type: "hunk", text: raw })
      continue
    }
    if (raw.startsWith("\\")) continue // "\ No newline at end of file"
    if (raw.startsWith("+")) lines.push({ type: "add", text: raw.slice(1), newNo: newNo++ })
    else if (raw.startsWith("-")) lines.push({ type: "del", text: raw.slice(1), oldNo: oldNo++ })
    else if (raw.length || lines.length)
      lines.push({ type: "context", text: raw.slice(1), oldNo: oldNo++, newNo: newNo++ })
  }
  return lines
}

/** Run git inside a WSL distro instead of on the Windows host. A WSL session's
 *  cwd is a Linux path the host can't see, so host git reports "not a git repo". */
export interface WslCtx {
  distro?: string // undefined = the default distro
}

/** `wsl.exe` args to run `<cmd> <args>` in <distro> at Linux <cwd>. Pure — tested.
 *  Uses `--cd` (the same mechanism we spawn WSL shells with). */
export function wslArgs(distro: string | undefined, cwd: string, cmd: string, args: string[]) {
  return [...(distro ? ["-d", distro] : []), "--cd", cwd, "--", cmd, ...args]
}

/** `wsl.exe` args to run `git <gitArgs>` in <distro> at Linux <cwd>. Pure — tested. */
export function wslGitArgs(distro: string | undefined, cwd: string, gitArgs: string[]): string[] {
  return wslArgs(distro, cwd, "git", ["-c", "core.quotepath=false", ...gitArgs])
}

async function run(cwd: string, args: string[], wsl?: WslCtx): Promise<string> {
  const maxBuffer = 64 * 1024 * 1024 // a mass rename can print a lot; the rows are capped after
  if (wsl) {
    // cwd is a Linux path valid only inside WSL — run git there, not on the host.
    const { stdout } = await exec("wsl.exe", wslGitArgs(wsl.distro, cwd, args), { maxBuffer })
    return stdout
  }
  const { stdout } = await exec("git", ["-c", "core.quotepath=false", ...args], { cwd, maxBuffer })
  return stdout
}

const NULL_DEVICE = process.platform === "win32" ? "NUL" : "/dev/null"

// A repo with more changes than this reports the first STATUS_CAP (+ the real total):
// shipping and rendering tens of thousands of rows every poll would stall the app.
export const STATUS_CAP = 5000
// Untracked files get a "+N lines" count read off disk; only this many per poll (async).
const COUNT_UNTRACKED = 200

/** `old -> new` from a porcelain rename line, split outside quotes (raw, still quoted). */
export function splitRename(s: string): [string, string] | null {
  let i: number
  if (s.startsWith('"')) {
    for (i = 1; i < s.length; i++) {
      if (s[i] === "\\") i++
      else if (s[i] === '"') break
    }
    i++
  } else {
    const at = s.indexOf(" -> ")
    if (at < 0) return null
    i = at
  }
  if (s.slice(i, i + 4) !== " -> ") return null
  return [s.slice(0, i), s.slice(i + 4)]
}

/** A porcelain path as git prints it: C-quoted ("…") when it has spaces, quotes or escapes. */
export function unquotePath(p: string): string {
  if (p.length < 2 || !p.startsWith('"') || !p.endsWith('"')) return p
  const body = p.slice(1, -1)
  const bytes: number[] = []
  const esc: Record<string, number> = {
    n: 10,
    t: 9,
    r: 13,
    '"': 34,
    "\\": 92,
    a: 7,
    b: 8,
    f: 12,
    v: 11,
  }
  for (let i = 0; i < body.length; i++) {
    const c = body[i]!
    if (c !== "\\") {
      bytes.push(...Buffer.from(c, "utf8"))
      continue
    }
    const n = body[i + 1] ?? ""
    if (/[0-7]/.test(n)) {
      bytes.push(parseInt(body.slice(i + 1, i + 4), 8)) // \ooo: one byte of a UTF-8 sequence
      i += 3
    } else {
      bytes.push(esc[n] ?? n.charCodeAt(0))
      i += 1
    }
  }
  return Buffer.from(bytes).toString("utf8")
}

/** `git status --porcelain=v1 -b` → header + capped entries (`dir/` = an untracked folder). */
export function parseStatusEntries(
  porcelain: string,
  cap = STATUS_CAP,
): { header: string; entries: { xy: string; path: string; isDir: boolean }[]; total: number } {
  let header = "## "
  const entries: { xy: string; path: string; isDir: boolean }[] = []
  let total = 0
  for (const line of porcelain.split("\n")) {
    if (!line) continue
    if (line.startsWith("## ")) {
      header = line
      continue
    }
    total++
    if (entries.length >= cap) continue
    // A rename/copy is `old -> new` (each side quoted on its own): the row is the new path,
    // as in numstat.
    const xy = line.slice(0, 2)
    const raw = /[RC]/.test(xy) ? (splitRename(line.slice(3))?.[1] ?? line.slice(3)) : line.slice(3)
    const p = unquotePath(raw)
    const isDir = p.endsWith("/")
    entries.push({ xy, path: isDir ? p.slice(0, -1) : p, isDir })
  }
  return { header, entries, total }
}

/** Working-tree status for a directory: branch, ahead/behind, changed files. */
export async function gitStatus(cwd: string, wsl?: WslCtx): Promise<GitStatus> {
  if (!cwd) return empty
  let porcelain: string
  try {
    // Git's default untracked mode: a wholly-untracked folder is ONE entry (`dir/`). With
    // --untracked-files=all, an un-ignored node_modules meant 35k entries per poll.
    porcelain = await run(cwd, ["status", "--porcelain=v1", "-b"], wsl)
  } catch {
    return empty // not a git repo (or git missing)
  }

  const { header, entries, total } = parseStatusEntries(porcelain)
  const { branch, ahead, behind } = parseBranchLine(header)

  // Independent: run both at once (each is a process spawn — a wsl.exe round trip on WSL).
  // numstat may fail with no HEAD yet (empty repo); root is best-effort ("" if it fails).
  // Porcelain paths are relative to the repo root, not to cwd (which may be a subfolder).
  const [numstatOut, rootOut] = await Promise.all([
    run(cwd, ["diff", "--numstat", "HEAD"], wsl).catch(() => ""),
    run(cwd, ["rev-parse", "--show-toplevel"], wsl).catch(() => ""),
  ])
  const numstat = parseNumstat(numstatOut)
  const root = rootOut.trim()
  const base = root || cwd

  // Untracked files get a "+N lines" count off disk: only the first COUNT_UNTRACKED per poll,
  // a few at a time, cached by size+mtime, counting newline bytes (no decode). Never a folder,
  // never on WSL (a Linux path isn't on the host). This used to read every untracked file
  // synchronously — the main process carries terminal I/O.
  const toCount = entries
    .filter((e) => statusOf(e.xy) === "?" && !e.isDir && !numstat.has(e.path) && !wsl)
    .slice(0, COUNT_UNTRACKED)
  const counts = new Map<string, number>()
  await inBatches(toCount, 8, async (e) =>
    counts.set(e.path, await countLines(path.join(base, e.path))),
  )

  const files: GitFile[] = entries.map(({ xy, path: p, isDir }) => {
    const status = statusOf(xy)
    const c = numstat.get(p) ?? { add: counts.get(p) ?? 0, del: 0 }
    return {
      path: p,
      name: path.basename(p),
      dir: path.dirname(p),
      status,
      ...c,
      ...(isDir ? { isDir } : {}),
    }
  })

  const add = files.reduce((n, f) => n + f.add, 0)
  const del = files.reduce((n, f) => n + f.del, 0)
  return {
    isRepo: true,
    root,
    branch,
    ahead,
    behind,
    files,
    add,
    del,
    ...(total > files.length ? { total } : {}),
  }
}

/** Unified diff for one file (handles untracked via --no-index). */
export async function gitDiff(cwd: string, file: string, wsl?: WslCtx): Promise<DiffLine[]> {
  if (!cwd || !file) return []
  const nul = wsl ? "/dev/null" : NULL_DEVICE // git runs inside Linux when wsl is set
  // Untracked / new file — or no HEAD yet (a repo without commits): diff against the null device.
  const vsNull = async () => {
    try {
      return await run(cwd, ["diff", "--no-index", "--", nul, file], wsl)
    } catch (e) {
      return (e as { stdout?: string }).stdout ?? "" // --no-index exits 1 when files differ
    }
  }
  let out: string
  try {
    out = await run(cwd, ["diff", "HEAD", "--", file], wsl)
  } catch {
    out = "" // bad revision HEAD (no commits yet)
  }
  return parseDiff(out.trim() ? out : await vsNull())
}

const lineCache = new Map<string, { key: string; lines: number }>() // path → by size+mtime
const LINE_CACHE_MAX = 2000

async function countLines(file: string): Promise<number> {
  try {
    // lstat + isFile: a symlink to /dev/zero or a FIFO must never be read (it would never end).
    const st = await fs.promises.lstat(file)
    if (st.isSymbolicLink()) return 1 // its diff is one line: the link's target
    if (!st.isFile() || st.size > 1024 * 1024) return 0 // big files: no count per poll
    const key = `${st.size}:${st.mtimeMs}`
    const hit = lineCache.get(file)
    if (hit?.key === key) return hit.lines
    const buf = await fs.promises.readFile(file)
    let lines = 0
    for (let i = buf.indexOf(10); i !== -1; i = buf.indexOf(10, i + 1)) lines++
    if (buf.length && buf[buf.length - 1] !== 10) lines++ // a last line without a newline
    if (lineCache.size >= LINE_CACHE_MAX) lineCache.delete(lineCache.keys().next().value!)
    lineCache.set(file, { key, lines })
    return lines
  } catch {
    return 0
  }
}

/** Run `fn` over `items`, at most `n` at a time. */
async function inBatches<T>(items: T[], n: number, fn: (x: T) => Promise<unknown>): Promise<void> {
  for (let i = 0; i < items.length; i += n) await Promise.all(items.slice(i, i + n).map(fn))
}

/** An untracked folder's direct contents, as git sees them (ignored, special files left out). */
export async function gitUntrackedListing(
  root: string, // the repo's top-level folder: dirRel is relative to it
  dirRel: string,
  wsl?: WslCtx,
): Promise<DirListing> {
  // git, not readdir: git applies the ignore rules (an `.env` never surfaces), skips FIFOs /
  // sockets / devices and empty folders, the same on every platform. Recursive — --directory
  // would collapse this very folder to one entry — then reduced to the first level; the
  // renderer re-lists an open folder only every few seconds. Any error → empty (fail closed).
  let out: string
  try {
    out = await run(
      root,
      [
        "--literal-pathspecs",
        "ls-files",
        "--others",
        "--exclude-standard",
        "-z",
        "--",
        `${dirRel}/`,
      ],
      wsl,
    )
  } catch {
    return toDirListing([])
  }
  const prefix = `${dirRel}/`
  const seen = new Map<string, boolean>()
  for (const p of out.split("\0")) {
    if (!p.startsWith(prefix)) continue
    const rest = p.slice(prefix.length)
    if (!rest) continue
    const slash = rest.indexOf("/")
    if (slash === -1) seen.set(rest, false)
    else seen.set(rest.slice(0, slash), true) // a deeper path → its first segment is a folder
  }
  return toDirListing([...seen].map(([name, isDir]) => ({ name, isDir })))
}
