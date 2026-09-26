// Reads the user's OpenSSH client config into a host list for the sidebar (SSH remotes,
// see SSH_REMOTES.md §3a). We only list aliases; `ssh <alias>` resolves everything else,
// so HostName/User/Port are kept for display only. Parsing is pure; file access is
// injected so the same loader reads a WSL distro's config (Linux paths) through its UNC
// share via wslMiniFs.

import fs from "node:fs"
import path from "node:path"
import { wslUncCandidates } from "./wsl-paths"

/** path.posix or path.win32 — the loader works in whichever namespace the config lives in. */
export type PlatformPath = typeof path.posix

/** One listable `Host` alias, with the values `ssh <alias>` would use (display only). */
export interface SshConfigHost {
  alias: string
  hostName?: string
  user?: string
  port?: string
}

type DisplayField = "hostName" | "user" | "port"

/** A config file in order: option blocks and `Include`s (with the Host patterns in effect
 *  where they appear). Lines before the first Host form a block with `lead` patterns. */
export type SshConfigItem =
  | { type: "block"; patterns: string[]; fields: Partial<Record<DisplayField, string>> }
  | { type: "include"; patterns: string[]; context: string[] }

/** One config line → tokens (whitespace/`=` separate, quotes group, `#` token ends it). */
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
const DISPLAY_FIELDS = new Map<string, DisplayField>([
  ["hostname", "hostName"],
  ["user", "user"],
  ["port", "port"],
])

type Block = Extract<SshConfigItem, { type: "block" }>

/** Parse one config file's text into ordered items. Pure; never throws. `lead` = the
 *  patterns lines before the first Host fall under: `*` at top level, else the includer's. */
export function parseSshConfig(text: string, lead: string[] = ["*"]): SshConfigItem[] {
  const items: SshConfigItem[] = []
  let block: Block | null = { type: "block", patterns: [...lead], fields: {} }
  items.push(block)
  for (const raw of text.split(/\r?\n/)) {
    const toks = tokenizeLine(raw)
    if (toks.length === 0) continue
    const key = toks[0]!.toLowerCase()
    const args = toks.slice(1)
    if (key === "host") {
      block = { type: "block", patterns: args.filter((a) => a.length > 0), fields: {} }
      items.push(block)
    } else if (key === "match") {
      block = null // can't evaluate Match criteria here: its options never reach the list
    } else if (key === "include") {
      if (args.length)
        items.push({ type: "include", patterns: args, context: block?.patterns ?? [] })
    } else if (block && args.length) {
      const field = DISPLAY_FIELDS.get(key)
      // First obtained value wins (OpenSSH semantics).
      if (field && block.fields[field] === undefined) block.fields[field] = args[0]
    }
  }
  return items.filter((it) => it.type === "include" || it.patterns.length > 0)
}

// A Host pattern we can't list: wildcards and negations match hosts, they don't name one.
const isPattern = (p: string) => /[*?]/.test(p) || p.startsWith("!")

/** A compiled Host line: case-insensitive; any `!pattern` match vetoes the whole line. */
export function hostMatcher(patterns: string[]): (alias: string) => boolean {
  const one = (pat: string): ((name: string) => boolean) => {
    const lower = pat.toLowerCase()
    if (!/[*?]/.test(lower)) return (name) => name === lower
    const re = new RegExp(
      "^" +
        lower
          .replace(/[.+^${}()|[\]\\]/g, "\\$&")
          .replace(/\*/g, ".*")
          .replace(/\?/g, ".") +
        "$",
    )
    return (name) => re.test(name)
  }
  const pos = patterns.filter((p) => !p.startsWith("!")).map(one)
  const neg = patterns.filter((p) => p.startsWith("!")).map((p) => one(p.slice(1)))
  return (alias) => {
    const name = alias.toLowerCase()
    return !neg.some((m) => m(name)) && pos.some((m) => m(name))
  }
}

/** Blocks in order (Includes inlined) → hosts, each with ssh's first-match-wins values. */
export function hostsFromBlocks(blocks: Omit<Block, "type">[]): SshConfigHost[] {
  const aliases: string[] = []
  const seen = new Set<string>()
  for (const b of blocks) {
    for (const p of b.patterns) {
      if (p && !isPattern(p) && !seen.has(p)) {
        seen.add(p)
        aliases.push(p)
      }
    }
  }
  const compiled = blocks.map((b) => ({ fields: b.fields, matches: hostMatcher(b.patterns) }))
  return aliases.map((alias) => {
    const host: SshConfigHost = { alias }
    for (const b of compiled) {
      if (!b.matches(alias)) continue
      for (const f of ["hostName", "user", "port"] as const) {
        if (host[f] === undefined && b.fields[f] !== undefined) host[f] = b.fields[f]
      }
    }
    // HostName may use %h (the alias) and %% (a literal %).
    if (host.hostName)
      host.hostName = host.hostName.replace(/%(%|h)/g, (_m, c: string) => (c === "h" ? alias : "%"))
    return host
  })
}

/** The file access the loader needs; both return null on any failure. */
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

/** Glob segment → RegExp: `*`, `?`, `[abc]`, `[!abc]`/`[^abc]`, `]` first in a class. */
export function globSegmentToRegExp(seg: string): RegExp {
  const escape = (c: string) => c.replace(/[.*+?^${}()|[\]\\/-]/g, "\\$&")
  let re = ""
  for (let i = 0; i < seg.length; i++) {
    const c = seg[i]!
    if (c === "*") re += ".*"
    else if (c === "?") re += "."
    else if (c === "[") {
      let j = i + 1
      const neg = seg[j] === "!" || seg[j] === "^"
      if (neg) j++
      const bodyStart = j
      if (seg[j] === "]") j++ // a `]` right after `[` (or `[!`) is a literal member
      const close = seg.indexOf("]", j)
      if (close === -1) {
        re += "\\[" // no closing bracket: a literal `[`
        continue
      }
      // Escape every member for the JS class, but keep `-` ranges (a-z) working.
      const body = seg.slice(bodyStart, close)
      let cls = ""
      for (let k = 0; k < body.length; k++) {
        const m = body[k]!
        const isRange = m === "-" && k > 0 && k < body.length - 1
        cls += isRange ? "-" : escape(m)
      }
      re += "[" + (neg ? "^" : "") + cls + "]"
      i = close
    } else re += escape(c)
  }
  return new RegExp("^" + re + "$")
}

/** Expand a glob path to existing entries, sorted; wildcards skip dotfiles (glob(3)). */
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

/** Load a config and its Includes into the host list. Each file is read once (cycles and
 *  diamonds included), nesting is capped, and unreadable files are skipped, never thrown. */
export async function loadSshConfig(opts: LoadOptions): Promise<LoadResult> {
  const maxDepth = opts.maxDepth ?? 16
  const blocks: Block[] = []
  const visited = new Set<string>()
  const files: string[] = []

  const visit = async (file: string, depth: number, lead: string[]): Promise<void> => {
    if (depth > maxDepth || visited.has(file)) return
    visited.add(file)
    const text = await opts.fs.readFile(file)
    if (text === null) return
    files.push(file)
    for (const item of parseSshConfig(text, lead)) {
      if (item.type === "block") {
        blocks.push(item)
        continue
      }
      for (const pat of item.patterns) {
        const resolved = resolveIncludePath(pat, opts.home, opts.path)
        for (const f of await expandGlob(resolved, opts.fs, opts.path)) {
          await visit(f, depth + 1, item.context)
        }
      }
    }
  }

  await visit(opts.file, 0, ["*"])
  return { hosts: hostsFromBlocks(blocks), files }
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

/** MiniFs over a WSL distro's UNC share, so the loader works in Linux paths (absolute
 *  Includes like /etc/ssh/… resolve inside the distro, not on the Windows drive). */
export function wslMiniFs(distro: string, base: MiniFs = nodeMiniFs): MiniFs {
  const first = async <T>(p: string, read: (q: string) => Promise<T | null>): Promise<T | null> => {
    for (const unc of wslUncCandidates(distro, p)) {
      const v = await read(unc)
      if (v !== null) return v
    }
    return null
  }
  return {
    readFile: (p) => first(p, base.readFile),
    readdir: (p) => first(p, base.readdir),
  }
}
