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
  ownMux?: true // its config sets ControlMaster/ControlPath: smterm must not add its own
}

type Field = "hostName" | "user" | "port" | "controlMaster" | "controlPath"
const DISPLAY: readonly Field[] = ["hostName", "user", "port"]

/** A config file in order: blocks (`maybe` = unevaluable Match) and Includes with context. */
export type SshConfigItem =
  | { type: "block"; patterns: string[]; fields: Partial<Record<Field, string>>; maybe?: true }
  | { type: "include"; patterns: string[]; context: string[] | null }

// ASCII whitespace only, as OpenSSH splits (an NBSP is part of a token there).
const isSpace = (c: string | undefined) => c !== undefined && /[ \t\r\n\v\f]/.test(c)

/** One config line → tokens, like OpenSSH's argv_split; [] for a comment, blank or bad line. */
export function tokenizeLine(line: string): string[] {
  const n = line.length
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
    // Quotes may open anywhere in a token; `\` escapes a quote, a backslash, or (outside
    // quotes) a space. An unterminated quote makes the line invalid, as it does for ssh.
    let tok = ""
    let quote: string | null = null
    while (i < n) {
      const c = line[i]!
      const next = line[i + 1]
      if (
        c === "\\" &&
        (next === '"' || next === "'" || next === "\\" || (!quote && next === " "))
      ) {
        tok += next
        i += 2
      } else if (quote) {
        if (c === quote) quote = null
        else tok += c
        i++
      } else if (isSpace(c)) {
        break
      } else if (c === '"' || c === "'") {
        quote = c
        i++
      } else {
        tok += c
        i++
      }
    }
    if (quote) return []
    out.push(tok)
  }
  return out
}

// Keywords we keep (lower-cased keyword → field).
const KEYWORD_FIELDS = new Map<string, Field>([
  ["hostname", "hostName"],
  ["user", "user"],
  ["port", "port"],
  ["controlmaster", "controlMaster"],
  ["controlpath", "controlPath"],
])

type Block = Extract<SshConfigItem, { type: "block" }>

/** Host patterns for a Match we can evaluate on an alias (`all`, `originalhost a,b`), else null. */
export function matchPatterns(args: string[]): string[] | null {
  const crit = args.map((a) => a.toLowerCase())
  // canonical/final blocks apply in a later pass we can't predict: unevaluable.
  if (crit.length === 1 && crit[0] === "all") return ["*"]
  if (crit.length === 2 && crit[0] === "originalhost" && args[1]) {
    const list = args[1].split(",").filter(Boolean)
    return list.length ? list : null
  }
  return null
}

/** Parse one config file's text into ordered items. Pure; never throws. */
export function parseSshConfig(text: string): SshConfigItem[] {
  const items: SshConfigItem[] = []
  let block: Block | null = { type: "block", patterns: ["*"], fields: {} }
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
      // A Match we can't evaluate may still apply: keep it as `maybe` (never listed or
      // displayed, but its ControlMaster/ControlPath make smterm step aside).
      const patterns = matchPatterns(args)
      block = patterns
        ? { type: "block", patterns, fields: {} }
        : { type: "block", patterns: ["*"], fields: {}, maybe: true }
      items.push(block)
    } else if (key === "include") {
      const context = block && !block.maybe ? block.patterns : null
      if (args.length) items.push({ type: "include", patterns: args, context })
      // The included file's options are read before the rest of this block's.
      if (block) {
        block = { ...block, fields: {} }
        items.push(block)
      }
    } else if (block && args.length) {
      const field = KEYWORD_FIELDS.get(key)
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

/** A loaded block; `guards` = Host lines of enclosing Includes (null = unevaluable Match). */
export interface GuardedBlock {
  patterns: string[]
  fields: Partial<Record<Field, string>>
  maybe?: true
  guards?: (string[] | null)[]
}

type Compiled = { b: GuardedBlock; maybe: boolean; applies: (alias: string) => boolean }

// A block applies when its own line and every evaluable guard match; `maybe` = some part
// of it is an unevaluable Match, so it might.
const compile = (blocks: GuardedBlock[]): Compiled[] =>
  blocks.map((b) => {
    const own = hostMatcher(b.patterns)
    const guards = (b.guards ?? []).filter((g) => g !== null).map(hostMatcher)
    const maybe = !!b.maybe || (b.guards ?? []).includes(null)
    return { b, maybe, applies: (alias) => own(alias) && guards.every((g) => g(alias)) }
  })

const setsMux = (c: readonly Compiled[], name: string) =>
  c.some(
    ({ b, applies }) =>
      (b.fields.controlMaster !== undefined || b.fields.controlPath !== undefined) && applies(name),
  )

/** A lookup (compiled once): might this config set multiplexing for `target` (`user@` stripped)? */
export function makeMuxLookup(blocks: GuardedBlock[]): (target: string) => boolean {
  const c = compile(blocks)
  return (target) => setsMux(c, target.slice(target.lastIndexOf("@") + 1))
}

/** One-off form of makeMuxLookup. */
export const muxSetFor = (blocks: GuardedBlock[], target: string) => makeMuxLookup(blocks)(target)

/** Blocks in order (Includes inlined) → hosts, each with ssh's first-match-wins values. */
export function hostsFromBlocks(blocks: GuardedBlock[]): SshConfigHost[] {
  const all = compile(blocks)
  const compiled = all.filter((c) => !c.maybe)
  // List each alias (case-insensitively once, as ssh matches) whose block applies to it.
  const aliases: string[] = []
  const seen = new Set<string>()
  for (const { b, applies } of compiled) {
    for (const p of b.patterns) {
      if (!p || isPattern(p) || seen.has(p.toLowerCase()) || !applies(p)) continue
      seen.add(p.toLowerCase())
      aliases.push(p)
    }
  }
  return aliases.map((alias) => {
    const v: Partial<Record<Field, string>> = {}
    for (const { b, applies } of compiled) {
      if (!applies(alias)) continue
      for (const f of DISPLAY)
        if (v[f] === undefined && b.fields[f] !== undefined) v[f] = b.fields[f]
    }
    const host: SshConfigHost = { alias }
    // HostName may use %h (the alias) and %% (a literal %).
    if (v.hostName)
      host.hostName = v.hostName.replace(/%(%|h)/g, (_m, c: string) => (c === "h" ? alias : "%"))
    if (v.user) host.user = v.user
    if (v.port) host.port = v.port
    if (setsMux(all, alias)) host.ownMux = true
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
  includeBase?: string // where relative Includes resolve: ~/.ssh (default), /etc/ssh for the system file
}

export interface LoadResult {
  hosts: SshConfigHost[]
  files: string[] // config files read, in order
  watch: string[] // paths whose change can alter the list: every file tried + glob dirs
  blocks: GuardedBlock[] // for muxSetFor, and merging with the system ssh_config
}

const GLOB_CHARS = /[*?[]/

/** Glob segment → RegExp: `*`, `?`, `[abc]`, `[!abc]`/`[^abc]`, `]` first, `\x` escapes. */
export function globSegmentToRegExp(seg: string): RegExp {
  const escape = (c: string) => c.replace(/[.*+?^${}()|[\]\\/-]/g, "\\$&")
  let re = ""
  for (let i = 0; i < seg.length; i++) {
    const c = seg[i]!
    if (c === "\\" && i + 1 < seg.length)
      re += escape(seg[++i]!) // `\*` is a literal `*`
    else if (c === "*") re += ".*"
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
  // POSIX splits on `/` only: a `\` there is a glob escape (or a filename character).
  const sep = p.sep === "/" ? /\/+/ : /[\\/]+/
  const segs = pattern.slice(root.length).split(sep).filter(Boolean)
  let bases = [root]
  for (const seg of segs) {
    const next: string[] = []
    if (!GLOB_CHARS.test(seg)) {
      const literal = p.sep === "/" ? seg.replace(/\\(.)/g, "$1") : seg
      for (const b of bases) next.push(p.join(b, literal))
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
export function resolveIncludePath(
  pattern: string,
  home: string,
  p: PlatformPath,
  base: string = p.join(home, ".ssh"),
): string {
  if (pattern === "~") return home
  if (pattern.startsWith("~/") || pattern.startsWith("~\\")) return p.join(home, pattern.slice(2))
  if (p.isAbsolute(pattern)) return pattern
  return p.join(base, pattern)
}

// Guards only grow with new information: a `*` context always matches, and a context
// already in the stack adds nothing.
const withGuard = (guards: (string[] | null)[], ctx: string[] | null) => {
  if (ctx && ctx.length === 1 && ctx[0] === "*") return guards
  const key = JSON.stringify(ctx)
  return guards.some((g) => JSON.stringify(g) === key) ? guards : [...guards, ctx]
}

// Guards are a conjunction, so their order doesn't matter: key evaluations on the set.
const guardKey = (guards: (string[] | null)[]) =>
  [...new Set(guards.map((g) => JSON.stringify(g)))].sort().join("\u0001")

// Hard backstop for pathological configs, far above any real one.
const MAX_EVALUATIONS = 2000
const MAX_BLOCKS = 20000

/** Load a config + Includes: each file read once, evaluated once per context, never throws. */
export async function loadSshConfig(opts: LoadOptions): Promise<LoadResult> {
  const maxDepth = opts.maxDepth ?? 16
  const base = opts.includeBase ?? opts.path.join(opts.home, ".ssh")
  const blocks: GuardedBlock[] = []
  const parsed = new Map<string, SshConfigItem[] | null>() // each file read + parsed once
  const evaluated = new Set<string>()
  const files: string[] = []
  const watch = new Set<string>()
  // Every path we try (found or not) can change the list when it appears or changes.
  const fs: MiniFs = {
    readFile: (p) => (watch.add(p), opts.fs.readFile(p)),
    readdir: (p) => (watch.add(p), opts.fs.readdir(p)),
  }
  const load = async (file: string) => {
    if (!parsed.has(file)) {
      const text = await fs.readFile(file)
      parsed.set(file, text === null ? null : parseSshConfig(text))
      if (text !== null) files.push(file)
    }
    return parsed.get(file)!
  }

  // `stack` = files on the current Include chain: a true cycle stops (ssh itself rejects one).
  const visit = async (
    file: string,
    depth: number,
    guards: (string[] | null)[],
    stack: string[],
  ) => {
    const key = `${file}\0${guardKey(guards)}`
    if (depth > maxDepth || stack.includes(file) || evaluated.has(key)) return
    if (evaluated.size >= MAX_EVALUATIONS || blocks.length >= MAX_BLOCKS) return
    evaluated.add(key)
    const items = await load(file)
    if (items === null) return
    const inner = [...stack, file]
    for (const item of items) {
      if (item.type === "block") {
        blocks.push({
          patterns: item.patterns,
          fields: item.fields,
          guards,
          ...(item.maybe ? { maybe: true as const } : {}),
        })
        continue
      }
      for (const pat of item.patterns) {
        const resolved = resolveIncludePath(pat, opts.home, opts.path, base)
        for (const f of await expandGlob(resolved, fs, opts.path)) {
          await visit(f, depth + 1, withGuard(guards, item.context), inner)
        }
      }
    }
  }

  await visit(opts.file, 0, [], [])
  return { hosts: hostsFromBlocks(blocks), files, watch: [...watch], blocks }
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

/** MiniFs mapping Linux paths onto a WSL distro's UNC share (remembers the working prefix). */
export function wslMiniFs(distro: string, base: MiniFs = nodeMiniFs): MiniFs {
  let preferred = 0 // index into wslUncCandidates' prefix order
  const first = async <T>(p: string, read: (q: string) => Promise<T | null>): Promise<T | null> => {
    const cands = wslUncCandidates(distro, p)
    const order = cands
      .map((_, k) => k)
      .sort((a, b) => (a === preferred ? -1 : b === preferred ? 1 : a - b))
    for (const k of order) {
      const v = await read(cands[k]!)
      if (v !== null) {
        preferred = k
        return v
      }
    }
    return null
  }
  return {
    readFile: (p) => first(p, base.readFile),
    readdir: (p) => first(p, base.readdir),
  }
}
