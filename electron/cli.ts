// `minmux open …`: the command line a second launch (or a cold first one) carries. Pure — the
// second instance parses its own argv before taking the lock (so it can print usage / errors
// and exit), and the lock holder validates what it was handed (asOpenRequest).
import path from "node:path"
import type { OpenRequest } from "../src/types"

export const USAGE = [
  "usage: minmux open [--tab <title>] [--cwd <dir>] [--split right|down] [-- <command> [args…]]",
  "       minmux --help",
  "",
  "Opens a pane in the running minmux (starting it if needed).",
  "  --tab <title>        the tab with that exact title, created if there's none (default: the active tab)",
  "  --cwd <dir>          where the pane starts (default: the current directory)",
  "  --split right|down   which side of the tab's focused pane it opens on (default: right)",
  "  -- <command> [args…] what the pane runs instead of the default shell",
].join("\n")

export type CliParse = { open: OpenRequest } | { help: true } | { error: string } | null

const isSplit = (v: unknown): v is NonNullable<OpenRequest["split"]> =>
  v === "right" || v === "down"

/** A program's argv: non-empty, all strings, a program name first. */
export const isArgv = (v: unknown): v is string[] =>
  Array.isArray(v) && v.length > 0 && v.every((a) => typeof a === "string") && v[0] !== ""

/** argv (argv[0] = the executable) → what to do; null = a plain launch, no subcommand. */
export function parseCli(argv: string[], cwd: string): CliParse {
  // The first "open" / "help" word: before it sit the executable, the app path in a dev
  // build (`electron .`) and Chromium/Electron switches (--profile=…), none of them ours.
  const at = argv.findIndex((a, i) => i > 0 && (a === "open" || a === "help" || a === "--help"))
  if (at < 0) return null
  if (argv[at] !== "open") return { help: true }
  const req: OpenRequest = { cwd }
  const rest = argv.slice(at + 1)
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!
    if (arg === "--") {
      const command = rest.slice(i + 1)
      if (!command.length) return { error: "missing command after --" }
      req.command = command
      break
    }
    if (arg === "--help" || arg === "-h") return { help: true }
    const eq = arg.indexOf("=")
    const name = arg.startsWith("--") && eq > 0 ? arg.slice(0, eq) : arg
    if (name !== "--tab" && name !== "--cwd" && name !== "--split")
      return {
        error: arg.startsWith("-")
          ? `unknown option ${arg}`
          : `unexpected argument ${arg} (put the command after --)`,
      }
    const inline = name !== arg
    const value = inline ? arg.slice(eq + 1) : rest[++i]
    // `--tab --cwd x`: a missing value, not a tab titled "--cwd" (use --tab=--cwd for that)
    if (value === undefined || (!inline && value.startsWith("--")))
      return { error: `${name} needs a value` }
    if (name === "--tab") {
      if (!value.trim()) return { error: "--tab needs a non-empty title" }
      req.tab = value
    } else if (name === "--cwd") {
      if (!value) return { error: "--cwd needs a directory" }
      req.cwd = path.resolve(cwd, value)
    } else {
      if (!isSplit(value)) return { error: `--split must be right or down, not ${value}` }
      req.split = value
    }
  }
  return { open: req }
}

/** What another process handed the lock holder → a request, or null if it isn't one. */
export function asOpenRequest(v: unknown): OpenRequest | null {
  if (!v || typeof v !== "object") return null
  const { cwd, tab, split, command } = v as Record<string, unknown>
  if (typeof cwd !== "string" || !path.isAbsolute(cwd)) return null
  if (tab !== undefined && (typeof tab !== "string" || !tab.trim())) return null
  if (split !== undefined && !isSplit(split)) return null
  if (command !== undefined && !isArgv(command)) return null
  const argv = command as string[] | undefined
  return { cwd, tab: tab as string | undefined, split, command: argv && [...argv] }
}

/** The lock holder's side of `second-instance`: a spooled entry → a request to open, or
 *  undefined (a plain launch, or not a request: `onInvalid` hears it). Never throws. */
export function receivedOpen(
  data: unknown,
  onInvalid: (raw: string) => void,
): OpenRequest | undefined {
  let raw: unknown
  try {
    raw = data && typeof data === "object" ? (data as { open?: unknown }).open : undefined
    if (raw === undefined) return undefined
    const req = asOpenRequest(raw)
    if (req) return req
  } catch {
    // an object that throws on reading: not a request either
  }
  onInvalid(safeJson(raw))
  return undefined
}

/** How old a handed-over request may be when the lock holder gets it. Older, its caller has
 *  long given up on it (the app was frozen, then resumed): dropped, never opened late. */
export const STALE_MS = 10_000

/** Sent at (the second instance's clock, `at` in its spooled entry) longer ago than STALE_MS. */
export function isStale(data: unknown, now: number): boolean {
  try {
    const at = data && typeof data === "object" ? (data as { at?: unknown }).at : undefined
    return typeof at === "number" && now - at > STALE_MS
  } catch {
    return false
  }
}

const safeJson = (v: unknown): string => {
  try {
    return String(JSON.stringify(v))
  } catch {
    return String(v)
  }
}
