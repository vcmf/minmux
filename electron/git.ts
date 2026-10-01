import { execFile } from "node:child_process"
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
    const split = file.includes(" => ") ? splitRename(file.replace(" => ", " -> ")) : null
    if (split && !file.includes("{")) file = split[1]
    else if (file.includes(" => "))
      file = file
        .replace(/\{.*? => (.*?)\}/g, "$1")
        .replace(/.* => /, "")
        .replace(/\/{2,}/g, "/") // "lib/{sub => }/x.ts" → "lib/x.ts", not "lib//x.ts"
        .replace(/^\//, "")
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

async function run(
  cwd: string,
  args: string[],
  wsl?: WslCtx,
  // A mass rename can print a lot (status rows are capped after); a diff passes tighter limits.
  { maxBuffer = 64 * 1024 * 1024, timeout = 0 }: { maxBuffer?: number; timeout?: number } = {},
): Promise<string> {
  if (wsl) {
    // cwd is a Linux path valid only inside WSL — run git there, not on the host.
    const { stdout } = await exec("wsl.exe", wslGitArgs(wsl.distro, cwd, args), {
      maxBuffer,
      timeout,
    })
    return stdout
  }
  const { stdout } = await exec("git", ["-c", "core.quotepath=false", ...args], {
    cwd,
    maxBuffer,
    timeout,
  })
  return stdout
}

const NULL_DEVICE = process.platform === "win32" ? "NUL" : "/dev/null"

// A hung git (network mount, fsmonitor, lock wait) mustn't stop the sequential poll for good;
// generous, so only a truly stuck git hits it (then it reads like any git failure).
const STATUS_LIMITS = { timeout: 60_000 }
// A repo with more changes than this reports the first STATUS_CAP (+ the real total):
// shipping and rendering tens of thousands of rows every poll would stall the app.
export const STATUS_CAP = 5000
// Untracked files get a "+N lines" count read off disk; only this many per poll (async).
const COUNT_UNTRACKED = 200
// A new folder with at most SMALL_DIR files (git's view: ignored ones excluded) lists them
// as rows with diffs, like any change; a bigger one (node_modules) stays one row. Checked for
// the first EXPAND_DIRS folders per poll (an output past maxBuffer is dropped). git walks a
// folder in full before printing, so one found big isn't re-walked for BIG_DIR_TTL.
const SMALL_DIR = 50
const EXPAND_DIRS = 10
const SMALL_DIR_LIMITS = { maxBuffer: 64 * 1024, timeout: 3000 }
const BIG_DIR_TTL = 5 * 60_000
const bigDirs = new Map<string, number>() // abs folder → when to check again

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

type StatusEntry = { xy: string; path: string; isDir: boolean }

/** `git status --porcelain=v1 -b` → header + capped entries (`dir/` = an untracked folder). */
export function parseStatusEntries(
  porcelain: string,
  cap = STATUS_CAP,
): { header: string; entries: StatusEntry[]; total: number } {
  let header = "## "
  const entries: StatusEntry[] = []
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

/** Replace each listed untracked folder by its files (in its place); null = keep the row. */
export function expandDirs(
  entries: StatusEntry[],
  listings: Map<string, string[] | null>,
): StatusEntry[] {
  return entries.flatMap((e) => {
    const files = e.isDir ? listings.get(e.path) : null
    if (!files?.length) return [e]
    // A nested repo (its own .git) is listed as "dir/": it stays a folder row.
    return files.map((f) =>
      f.endsWith("/")
        ? { xy: "??", path: f.slice(0, -1), isDir: true }
        : { xy: "??", path: f, isDir: false },
    )
  })
}

const dirKey = (base: string, dir: string, wsl?: WslCtx) =>
  `${wsl ? `wsl:${wsl.distro ?? ""}:` : ""}${base}/${dir}`

/** Still inside its BIG_DIR_TTL (an expired entry is dropped). */
function knownBig(key: string): boolean {
  const until = bigDirs.get(key)
  if (until === undefined) return false
  if (until > Date.now()) return true
  bigDirs.delete(key)
  return false
}

/** Files git would report under an untracked `dir` (root-relative), or null if > SMALL_DIR. */
async function smallDirFiles(base: string, dir: string, wsl?: WslCtx): Promise<string[] | null> {
  const key = dirKey(base, dir, wsl)
  const big = () => {
    bigDirs.delete(key) // re-insert at the end: eviction drops the least recently found
    if (bigDirs.size >= 500) bigDirs.delete(bigDirs.keys().next().value!)
    bigDirs.set(key, Date.now() + BIG_DIR_TTL)
    return null
  }
  try {
    const out = await run(
      base,
      ["--literal-pathspecs", "ls-files", "-z", "--others", "--exclude-standard", "--", dir],
      wsl,
      SMALL_DIR_LIMITS,
    )
    const files = out.split("\0").filter(Boolean)
    return files.length <= SMALL_DIR ? files : big()
  } catch (e) {
    // Too much output = big (remembered); slow or failed: keep the row, try again next poll.
    const code = (e as { code?: string }).code
    return code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" ? big() : null
  }
}

/** Working-tree status for a directory: branch, ahead/behind, changed files. */
export async function gitStatus(cwd: string, wsl?: WslCtx): Promise<GitStatus> {
  if (!cwd) return empty
  let porcelain: string
  try {
    // Git's default untracked mode: a wholly-untracked folder is ONE entry (`dir/`). With
    // --untracked-files=all, an un-ignored node_modules meant 35k entries per poll.
    // Explicit, so a user's status.showUntrackedFiles (no / all) can't hide them or bring the
    // 35k entries back.
    porcelain = await run(
      cwd,
      ["--no-optional-locks", "status", "--porcelain=v1", "-b", "--untracked-files=normal"],
      wsl,
      STATUS_LIMITS,
    )
  } catch {
    return empty // not a git repo, git missing, or stuck past STATUS_LIMITS
  }

  const parsed = parseStatusEntries(porcelain)
  const { header } = parsed
  const { branch, ahead, behind } = parseBranchLine(header)

  // Independent: run both at once (each is a process spawn — a wsl.exe round trip on WSL).
  // numstat may fail with no HEAD yet (empty repo); root is best-effort ("" if it fails).
  // Porcelain paths are relative to the repo root, not to cwd (which may be a subfolder).
  const [numstatOut, rootOut] = await Promise.all([
    run(cwd, ["diff", "--numstat", "HEAD"], wsl, STATUS_LIMITS).catch(() => ""),
    run(cwd, ["rev-parse", "--show-toplevel"], wsl, STATUS_LIMITS).catch(() => ""),
  ])
  const numstat = parseNumstat(numstatOut)
  const root = rootOut.trim()
  const base = root || cwd

  // Root-relative folder paths need the root; folders already known big don't take a slot.
  const dirs = root
    ? parsed.entries
        .filter((e) => e.isDir && statusOf(e.xy) === "?" && !knownBig(dirKey(root, e.path, wsl)))
        .slice(0, EXPAND_DIRS)
    : []
  const listings = new Map<string, string[] | null>()
  await inBatches(dirs, 4, async (e) =>
    listings.set(e.path, await smallDirFiles(base, e.path, wsl)),
  )
  const expanded = expandDirs(parsed.entries, listings)
  // A folder's files are rows like any other: count them, and keep the row cap.
  const total = parsed.total + expanded.length - parsed.entries.length
  const entries = expanded.slice(0, STATUS_CAP)

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

  // Totals over every change (numstat isn't capped), not just the files listed.
  let add = 0
  let del = 0
  for (const c of numstat.values()) {
    add += c.add
    del += c.del
  }
  for (const n of counts.values()) add += n
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
// A diff that runs too long (a symlink to a FIFO makes `--no-index` read forever) or prints too
// much (a multi-MB file) is cut off with a note: never a hung git, never a frozen panel.
const DIFF_LIMITS = { maxBuffer: 4 * 1024 * 1024, timeout: 10_000 }

export async function gitDiff(cwd: string, file: string, wsl?: WslCtx): Promise<DiffLine[]> {
  if (!cwd || !file) return []
  const nul = wsl ? "/dev/null" : NULL_DEVICE // git runs inside Linux when wsl is set
  const note = (text: string): DiffLine[] => [{ type: "hunk", text }]
  const limited = (e: unknown): DiffLine[] | null => {
    const err = e as { code?: string; killed?: boolean; signal?: string }
    if (err.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") return note("… diff too large to show")
    if (err.killed || err.signal === "SIGTERM") return note("… diff took too long to show")
    return null
  }
  let out: string
  let failed = false
  try {
    // Literal: a path like app/[id]/page.tsx is a file name, not a glob.
    out = await run(cwd, ["--literal-pathspecs", "diff", "HEAD", "--", file], wsl, DIFF_LIMITS)
  } catch (e) {
    const cut = limited(e)
    if (cut) return cut
    out = "" // bad revision HEAD (no commits yet) — checked below
    failed = true
  }
  if (out.trim()) return parseDiff(out)
  // Nothing vs HEAD: an untracked file (or no HEAD yet) → diff against the null device. A
  // TRACKED file that matches HEAD (edited back, a phantom CRLF change) stays empty — never
  // shown as wholly added.
  let tracked: string
  try {
    tracked = await run(cwd, ["--literal-pathspecs", "ls-files", "--", file], wsl, DIFF_LIMITS)
  } catch {
    return [] // can't tell: never risk showing a tracked file as wholly added
  }
  if (tracked.trim()) {
    // With no HEAD (no commits yet) a staged file is all new; any other failure: no diff.
    const noHead =
      failed &&
      (await run(cwd, ["rev-parse", "--verify", "-q", "HEAD"], wsl, DIFF_LIMITS).then(
        () => false,
        (e: { code?: unknown }) => e.code === 1, // exit 1 = no HEAD; a kill/error isn't
      ))
    if (!noHead) return []
  }
  try {
    return parseDiff(await run(cwd, ["diff", "--no-index", "--", nul, file], wsl, DIFF_LIMITS))
  } catch (e) {
    return limited(e) ?? parseDiff((e as { stdout?: string }).stdout ?? "") // exit 1 = differs
  }
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
