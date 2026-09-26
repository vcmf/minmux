// Reads the user's OpenSSH client config into a host list for the sidebar (SSH remotes,
// see SSH_REMOTES.md §3a). We only list aliases; `ssh <alias>` resolves everything else,
// so HostName/User/Port are kept for display only. Parsing is pure; file access is
// injected so the same loader reads a WSL distro's config through its UNC share.

import fs from "node:fs"
import path from "node:path"

/** path.posix or path.win32 — the loader works in whichever namespace the config lives in. */
export type PlatformPath = typeof path.posix

/** One listable `Host` alias (display fields are the block's first values). */
export interface SshConfigHost {
  alias: string
  hostName?: string
  user?: string
  port?: string
}

/** A config file in order: host aliases and `Include` directives where they appear. */
export type SshConfigItem =
  { type: "host"; host: SshConfigHost } | { type: "include"; patterns: string[] }

/** Split one config line into tokens: whitespace or a single `=` separates, double quotes
 *  group, an unquoted token starting with `#` ends the line (OpenSSH ≥ 8.7 semantics). */
export function tokenizeLine(line: string): string[] {
  const n = line.length
  const isSpace = (c: string | undefined) => c !== undefined && /\s/.test(c)
  let i = 0
  while (isSpace(line[i])) i++
  if (i >= n || line[i] === "#") return []
  // Keyword: up to whitespace or `=`, then an optional `=` with spaces around it.
  let key = ""
  while (i < n && !isSpace(line[i]) && line[i] !== "=") key += line[i++]
  if (!key) return []
  while (isSpace(line[i])) i++
  if (line[i] === "=") i++
  const out = [key]
  for (;;) {
    while (isSpace(line[i])) i++
    if (i >= n || line[i] === "#") break
    let tok = ""
    if (line[i] === '"') {
      i++
      while (i < n && line[i] !== '"') tok += line[i++]
      i++ // past the closing quote (or the end of an unterminated one)
    } else {
      while (i < n && !isSpace(line[i])) tok += line[i++]
    }
    out.push(tok)
  }
  return out
}

// Keywords we keep for the sidebar subline (lower-cased keyword → field).
const DISPLAY_FIELDS = new Map<string, "hostName" | "user" | "port">([
  ["hostname", "hostName"],
  ["user", "user"],
  ["port", "port"],
])

// A Host pattern we can't list: wildcards and negations match hosts, they don't name one.
const isPattern = (alias: string) => /[*?]/.test(alias) || alias.startsWith("!")

/** Parse one config file's text into ordered items. Pure; never throws. */
export function parseSshConfig(text: string): SshConfigItem[] {
  const items: SshConfigItem[] = []
  let block: SshConfigHost[] = [] // hosts of the current Host block (share its display fields)
  let inMatch = false
  for (const raw of text.split(/\r?\n/)) {
    const toks = tokenizeLine(raw)
    if (toks.length === 0) continue
    const key = toks[0]!.toLowerCase()
    const args = toks.slice(1)
    if (key === "host") {
      inMatch = false
      block = args
        .filter((a) => a.length > 0 && !isPattern(a))
        .map((alias) => ({ alias }) as SshConfigHost)
      for (const host of block) items.push({ type: "host", host })
      continue
    }
    if (key === "match") {
      inMatch = true
      block = []
      continue
    }
    if (key === "include") {
      if (args.length) items.push({ type: "include", patterns: args })
      continue
    }
    if (inMatch || block.length === 0 || args.length === 0) continue
    const field = DISPLAY_FIELDS.get(key)
    if (!field) continue
    // First obtained value wins (OpenSSH semantics).
    for (const h of block) if (h[field] === undefined) h[field] = args[0]
  }
  return items
}

/** The file access the loader needs. Both return null on any failure (missing, too big, …). */
export interface MiniFs {
  readFile: (p: string) => Promise<string | null>
  readdir: (p: string) => Promise<string[] | null>
}

export interface LoadOptions {
  file: string // the top-level config (e.g. ~/.ssh/config)
  home: string // for `~` and relative Include paths (~/.ssh/<path>)
  fs: MiniFs
  path: PlatformPath // path.posix for macOS/Linux/WSL, path.win32 for native Windows
  maxDepth?: number // Include nesting cap (OpenSSH uses 16)
}

/** Every config file read, in order (the caller watches these for changes). */
export interface LoadResult {
  hosts: SshConfigHost[]
  files: string[]
}

const GLOB_CHARS = /[*?[]/

/** Glob segment → RegExp: `*`, `?`, `[abc]`, `[!abc]` / `[^abc]`. */
export function globSegmentToRegExp(seg: string): RegExp {
  let re = ""
  for (let i = 0; i < seg.length; i++) {
    const c = seg[i]!
    if (c === "*") re += ".*"
    else if (c === "?") re += "."
    else if (c === "[") {
      const end = seg.indexOf("]", i + 2)
      if (end === -1) {
        re += "\\["
        continue
      }
      let body = seg.slice(i + 1, end)
      if (body.startsWith("!") || body.startsWith("^")) body = "^" + body.slice(1)
      re += "[" + body.replace(/\\/g, "\\\\") + "]"
      i = end
    } else re += c.replace(/[.+^${}()|\\\]]/g, "\\$&")
  }
  return new RegExp("^" + re + "$")
}

/** Expand a glob path (wildcards in any segment) to existing entries, sorted per segment.
 *  Wildcards don't match a leading `.` unless the segment itself starts with one (glob(3)). */
export async function expandGlob(pattern: string, fs: MiniFs, p: PlatformPath): Promise<string[]> {
  if (!GLOB_CHARS.test(pattern)) return [pattern]
  const root = p.parse(pattern).root
  const segs = pattern
    .slice(root.length)
    .split(/[\\/]+/)
    .filter(Boolean)
  let bases = [root]
  for (const seg of segs) {
    const next: string[] = []
    if (!GLOB_CHARS.test(seg)) {
      for (const b of bases) next.push(p.join(b, seg))
    } else {
      const re = globSegmentToRegExp(seg)
      for (const b of bases) {
        const names = (await fs.readdir(b || ".")) ?? []
        for (const name of [...names].sort()) {
          if (name.startsWith(".") && !seg.startsWith(".")) continue
          if (re.test(name)) next.push(p.join(b, name))
        }
      }
    }
    bases = next
    if (bases.length === 0) break
  }
  return bases
}

/** `~` → home; a relative Include path resolves against ~/.ssh (user config semantics). */
export function resolveIncludePath(pattern: string, home: string, p: PlatformPath): string {
  if (pattern === "~") return home
  if (pattern.startsWith("~/") || pattern.startsWith("~\\")) return p.join(home, pattern.slice(2))
  if (p.isAbsolute(pattern)) return pattern
  return p.join(home, ".ssh", pattern)
}

/** Load a config and its Includes into a de-duplicated host list (first alias wins).
 *  Cycle-safe and depth-capped; unreadable files are skipped, never thrown. */
export async function loadSshConfig(opts: LoadOptions): Promise<LoadResult> {
  const maxDepth = opts.maxDepth ?? 16
  const hosts: SshConfigHost[] = []
  const seen = new Set<string>()
  const files: string[] = []

  const visit = async (file: string, depth: number, stack: Set<string>): Promise<void> => {
    if (depth > maxDepth || stack.has(file)) return
    const text = await opts.fs.readFile(file)
    if (text === null) return
    files.push(file)
    const inner = new Set(stack).add(file)
    for (const item of parseSshConfig(text)) {
      if (item.type === "host") {
        if (seen.has(item.host.alias)) continue
        seen.add(item.host.alias)
        hosts.push(item.host)
        continue
      }
      for (const pat of item.patterns) {
        const resolved = resolveIncludePath(pat, opts.home, opts.path)
        for (const f of await expandGlob(resolved, opts.fs, opts.path)) {
          await visit(f, depth + 1, inner)
        }
      }
    }
  }

  await visit(opts.file, 0, new Set())
  return { hosts, files }
}

const MAX_CONFIG_BYTES = 1024 * 1024 // a real ssh config is a few KB; bound main memory

/** Real filesystem access for the loader (node fs, size-capped, errors → null). */
export const nodeMiniFs: MiniFs = {
  readFile: async (p) => {
    try {
      const st = await fs.promises.stat(p)
      if (!st.isFile() || st.size > MAX_CONFIG_BYTES) return null
      return await fs.promises.readFile(p, "utf8")
    } catch {
      return null
    }
  },
  readdir: async (p) => {
    try {
      return await fs.promises.readdir(p)
    } catch {
      return null
    }
  },
}
