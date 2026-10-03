// The Codex CLI adapter (docs/design/MULTI_AGENT.md; spike S1). Codex speaks Claude's hook
// contract (same event names and fields), so its hooks reuse Claude's normaliser. They are
// added per launch with `codex -c hooks.<Event>=[…]` from an rc wrapper: a layer of its own,
// on top of the user's hooks (S1-a), and approved once in Codex's `/hooks` — approval is keyed
// by the definition's hash, so the definition holds no per-launch or per-pane value.

import { createHash } from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import type { AgentEvent, TokenUsage } from "../../src/lib/agent-graph"
import type { LedgerEntry } from "../agent-sessions"
import { posixQuote } from "../../src/lib/shell-quote"
import { tokenEventsForBatch } from "../agent-tokens"
import { HOOK_WRITER } from "../hook-writer"
import { TranscriptFold } from "../transcript-fold"
import { emptyUsage, num } from "../transcript-tokens"
import { writeIfChanged } from "./files"
import { normalizeHookEvent, SAFE_ID } from "./claude"
import type { MetaReader } from "../agent-meta"
import type { AgentAdapter, AgentShell, AgentSpec, SessionRules } from "./types"

// The events we consume; tool events take a matcher (S1-d).
const EVENTS = [
  "SessionStart",
  "SessionEnd",
  "UserPromptSubmit",
  "Stop",
  "Interrupt",
  "PermissionRequest",
  "PreToolUse",
  "PostToolUse",
  "SubagentStart",
  "SubagentStop",
]
const TOOL_EVENTS = new Set(["PreToolUse", "PostToolUse", "PermissionRequest"])
// Codex clamps these to 3 s and runs SessionEnd synchronously; asking for more lists the hook
// under "Issues" on `/hooks` (S1).
const SHORT = new Set(["SessionEnd", "Interrupt"])

/** A TOML basic string. */
const toml = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`

/** One of our hooks, as Codex sees it. */
interface CodexHook {
  event: string
  matcher?: string
  command: string
  timeout: number
  async: boolean
}

/** Our hooks for a drop script: one per event. */
function codexHooks(dropScript: string): CodexHook[] {
  // `exec`: the shell Codex runs the command in becomes node, so node's parent is Codex
  // itself (the writer records that pid: the lead rule).
  const command = `exec node ${posixQuote(dropScript)} codex`
  return EVENTS.map((event) => ({
    event,
    ...(TOOL_EVENTS.has(event) ? { matcher: "" } : {}),
    command,
    timeout: SHORT.has(event) ? 3 : 5,
    async: event !== "SessionEnd",
  }))
}

/** The `codex` arguments that add our hooks: `-c`, `hooks.<Event>=[…]` pairs. Pure; the same
 *  `dropScript` path always gives the same hooks (Codex's approval is keyed by them). */
export function codexHookArgs(dropScript: string): string[] {
  return codexHooks(dropScript).flatMap((h) => {
    const hook =
      `{type="command",command=${toml(h.command)},timeout=${h.timeout}` +
      (h.async ? ",async=true}" : "}")
    const entry =
      h.matcher !== undefined ? `{matcher=${toml(h.matcher)},hooks=[${hook}]}` : `{hooks=[${hook}]}`
    return ["-c", `hooks.${h.event}=[${entry}]`]
  })
}

/** Codex's `snake_case` label of an event (its trust records use it). */
const eventLabel = (event: string) =>
  event.replace(/[A-Z]/g, (c, i) => (i ? "_" : "") + c.toLowerCase())

/** JSON with every object's keys sorted, compact (serde_json's `sort_all_objects` + `to_vec`). */
const sortedJson = (v: unknown): string =>
  Array.isArray(v)
    ? `[${v.map(sortedJson).join(",")}]`
    : v && typeof v === "object"
      ? `{${Object.keys(v)
          .sort()
          .map((k) => `${JSON.stringify(k)}:${sortedJson((v as Record<string, unknown>)[k])}`)
          .join(",")}}`
      : JSON.stringify(v)

/** Codex's trust hash for each of our hooks, keyed by its trust record's key. */
export function codexTrustHashes(dropScript: string): Map<string, string> {
  // sha256 of the normalized identity {event_name, matcher, hooks: [handler]} as sorted JSON,
  // as `hook_hash` / `version_for_toml` compute it (codex-rs/hooks/src/engine/discovery.rs).
  const out = new Map<string, string>()
  for (const h of codexHooks(dropScript)) {
    const identity = {
      event_name: eventLabel(h.event),
      ...(h.matcher !== undefined ? { matcher: h.matcher } : {}),
      hooks: [{ type: "command", command: h.command, timeout: h.timeout, async: h.async }],
    }
    const hash = createHash("sha256").update(sortedJson(identity)).digest("hex")
    out.set(`/<session-flags>/config.toml:${eventLabel(h.event)}:0:0`, `sha256:${hash}`)
  }
  return out
}

/** Has Codex approved every one of these hooks? From its config.toml's `[hooks.state."<key>"]`
 *  tables (`trusted_hash = "…"`), which Codex writes when the user trusts them. */
export function codexApproved(configToml: string, hashes: Map<string, string>): boolean {
  const trusted = new Map<string, string>()
  let table: string | null = null
  for (const line of configToml.split(/\r?\n/)) {
    const head = /^\s*\[hooks\.state\."([^"]+)"\]\s*$/.exec(line)
    if (head) table = head[1]!
    else if (/^\s*\[/.test(line)) table = null
    else if (table) {
      const m = /^\s*trusted_hash\s*=\s*"([^"]+)"/.exec(line)
      if (m) trusted.set(table, m[1]!)
    }
  }
  return hashes.size > 0 && [...hashes].every(([key, hash]) => trusted.get(key) === hash)
}

// `apply_patch` sends the patch text; its file headers name what it touches (S1-d).
const PATCH_FILE = /^\*\*\* (?:Add|Update|Delete) File: (.+?)\r?$/m
const MAX_PATCH_SCAN = 256 * 1024

/** Codex hook JSON → an AgentEvent: Claude's fields, plus Interrupt as a turn end and the file
 *  an `apply_patch` touches. */
export function normalizeCodexEvent(raw: unknown, paneId?: string): AgentEvent | null {
  const ev = normalizeHookEvent(raw, paneId)
  if (!ev) return null
  const out: AgentEvent = { ...ev } // the watcher stamps the agent from the folder
  if (out.event === "Interrupt") out.event = "Stop"
  if (!out.filePath && out.toolName === "apply_patch") {
    const ti = (raw as { tool_input?: { command?: unknown } }).tool_input
    const patch = typeof ti?.command === "string" ? ti.command.slice(0, MAX_PATCH_SCAN) : ""
    const m = PATCH_FILE.exec(patch)
    if (m) out.filePath = m[1]!.trim()
  }
  return out
}

// Codex logs `event_msg` / `token_count` records (S1): `last_token_usage.total_tokens` is what
// the latest request filled, `total_token_usage.output_tokens` the session's output so far,
// `model_context_window` the window. The badge's % is of the full window (Codex's own meter
// subtracts a baseline first, so it reads a little lower). Other lines are skipped.
/** Fold one rollout `token_count` line into context, output so far and window (pure). */
export function addCodexTokenLine(acc: TokenUsage, line: string): TokenUsage {
  if (!line.includes('"token_count"')) return acc // cheap pre-filter: most lines aren't
  let o: unknown
  try {
    o = JSON.parse(line)
  } catch {
    return acc
  }
  const rec = o as { type?: unknown; payload?: { type?: unknown; info?: unknown } }
  if (rec?.type !== "event_msg" || rec.payload?.type !== "token_count") return acc
  const info = rec.payload.info as
    | {
        last_token_usage?: { input_tokens?: unknown; total_tokens?: unknown }
        total_token_usage?: { output_tokens?: unknown }
        model_context_window?: unknown
      }
    | null
    | undefined
  if (!info || typeof info !== "object") return acc // an early record has no info yet
  const window = num(info.model_context_window) || acc.window
  return {
    // What the last request filled (input + its output), as Codex's own context meter counts.
    context:
      num(info.last_token_usage?.total_tokens) ||
      num(info.last_token_usage?.input_tokens) ||
      acc.context,
    output: Math.max(acc.output, num(info.total_token_usage?.output_tokens)),
    ...(window ? { window } : {}),
  }
}

/** Incremental per-rollout token totals (see TranscriptFold). */
export class CodexTokens extends TranscriptFold<TokenUsage> {
  constructor(chunkBytes?: number) {
    super(addCodexTokenLine, emptyUsage, chunkBytes)
  }
}

/** Codex's thread names: `<codex home>/session_index.jsonl`, one `{id, thread_name}` line per
 *  change, the latest per id winning (S1). Home comes from the rollout path the hooks report
 *  (`<home>/sessions/YYYY/MM/DD/rollout-…jsonl`), so a custom CODEX_HOME just works. */
export function codexIndexFor(transcriptPath: string | undefined): string | null {
  const m = /^(.*)([\\/])sessions\2\d{4}\2\d{2}\2\d{2}\2[^\\/]+\.jsonl$/.exec(transcriptPath ?? "")
  return m ? `${m[1]}${m[2]}session_index.jsonl` : null
}

/** A thread's name and whether the user gave it (vs Codex). */
export interface ThreadName {
  name: string
  user: boolean
}

/** Fold one index line into the id → name map (latest wins, junk skipped). */
// Codex writes a thread's first name itself (after its first turn); `/rename` appends another
// line for the same id (S1-g), so any later, different name is the user's. Known limit: a
// `/rename` before the first turn ends is the first line, so it reads as Codex's own.
export function addThreadNameLine(
  acc: Map<string, ThreadName> | null,
  line: string,
): Map<string, ThreadName> | null {
  // Mutates (and creates) the fold's private Map: one copy per line would make reading a long
  // index O(N²) on the main process, which also forwards terminal output.
  if (!line.includes('"thread_name"')) return acc
  let o: unknown
  try {
    o = JSON.parse(line)
  } catch {
    return acc
  }
  const r = o as { id?: unknown; thread_name?: unknown }
  if (typeof r?.id !== "string" || typeof r.thread_name !== "string") return acc
  const map = acc ?? new Map<string, ThreadName>()
  const name = r.thread_name.trim()
  const prev = map.get(r.id)
  if (!prev) map.set(r.id, { name, user: false })
  else if (prev.name !== name) map.set(r.id, { name, user: true })
  return map
}

/** Codex's meta: the session's thread name; only a user's `/rename` colours its pane (D3). */
export const threadNameReader = (): MetaReader => {
  // Keyed by the path the hooks report: fine while Codex runs only on macOS/Linux; with WSL
  // panes, two distros' indexes would share it (key by distro + path then).
  const fold = new TranscriptFold<Map<string, ThreadName> | null>(addThreadNameLine, null)
  return {
    update: async (key, candidates, sessionId) => {
      const t = sessionId ? (await fold.update(key, candidates))?.get(sessionId) : undefined
      return !t ? {} : t.user ? { name: t.name } : { name: t.name, auto: true }
    },
    // One shared, append-only file: keep what's been read of it for the app's lifetime instead
    // of re-reading it from the start every time its last pane lets go (a `/new`, a restart).
    forget: () => {},
  }
}

/** Codex's lead + resume rules: sessions of the leading Codex process switch freely (`/new`,
 *  the resume picker); another process's are background agents. The process is the hook's
 *  parent (`exec node …` makes Codex itself that parent); if a wrapper ever stood between
 *  them, every new thread would read as a background agent (known limit). */
export const codexSessionRules: SessionRules = {
  resumeCommand: (e: LedgerEntry) =>
    SAFE_ID.test(e.sessionId) ? `codex resume ${e.sessionId}` : null,
  cwdFits: () => undefined, // rollouts are found by id, not by folder
  isSwitch: (ev, lead) => ev.pid !== undefined && ev.pid === lead.pid,
  liveByPid: true, // `exec node …`: the hook's parent is Codex itself (a test pins the exec)
}

// Codex's subcommands that never open its interactive UI (`codex --help`); a bare `codex`, a
// prompt, `resume` and `fork` do. The first word that isn't a flag (or a flag's value) decides.
const NO_TUI =
  "exec|e|review|login|logout|mcp|plugin|app-server|remote-control|app|completion|update|" +
  "doctor|sandbox|debug|apply|a|queue|archive|delete|migrate-rollouts|unarchive|cloud|" +
  "exec-server|features|help|agents"
const VALUE_FLAGS =
  "-c|--config|-m|--model|-p|--profile|-s|--sandbox|-a|--ask-for-approval|-C|--cd|" +
  "-i|--image|--local-provider|--enable|--disable|--add-dir"
// zsh and bash share it.
const CODEX_MARKER = [
  "    local a skip= tui=1",
  '    for a in "$@"; do',
  "      [[ -n $skip ]] && { skip=; continue; }",
  '      case "$a" in',
  `        ${VALUE_FLAGS}) skip=1 ;;`,
  "        -V|--version|-h|--help) tui=; break ;;",
  "        --) break ;;",
  "        -*) ;;",
  `        ${NO_TUI}) tui=; break ;;`,
  "        *) break ;;",
  "      esac",
  "    done",
  "    [[ -n $tui && -t 1 ]] && printf '\\033]6974;agent;codex\\007'",
]

/** Adds our hooks to `codex` while minmux provides the args file (one argument per line, so
 *  quotes and spaces reach Codex intact). Line arrays, reviewed as shell. */
export const codexShell: AgentShell = {
  zsh: [
    "# Add minmux's hooks to `codex` (agents board): one argument per line in the file.",
    'if [[ -o interactive && -n "${MINMUX_CODEX_ARGS-}" ]]; then',
    "  function codex {", // not `codex()`: a user alias `codex` would break the rc
    // Its hook runs `node`: a file on this PATH (not a function: nvm lazy-load), else plain Codex.
    '    [[ -r "$MINMUX_CODEX_ARGS" ]] && whence -p node >/dev/null || { command codex "$@"; return }',
    // A display-only launch marker for minmux's approval hint: only for Codex's interactive UI
    // (not `exec`, `login`, …) and only onto a terminal, never into a pipe or `$(…)`.
    ...CODEX_MARKER,
    '    command codex "${(@f)"$(<"$MINMUX_CODEX_ARGS")"}" "$@"',
    "  }",
    "fi",
  ],
  bash: [
    "# Add minmux's hooks to `codex` (agents board): one argument per line in the file.",
    'if [[ $- == *i* && -n "${MINMUX_CODEX_ARGS-}" ]]; then',
    "  function codex {",
    '    [[ -r "$MINMUX_CODEX_ARGS" ]] && type -P node >/dev/null || { command codex "$@"; return; }',
    "    local -a __minmux_a=()",
    "    local __minmux_l",
    '    while IFS= read -r __minmux_l || [[ -n "$__minmux_l" ]]; do',
    '      __minmux_a+=("$__minmux_l")',
    '    done < "$MINMUX_CODEX_ARGS"',
    ...CODEX_MARKER,
    '    command codex ${__minmux_a[@]+"${__minmux_a[@]}"} "$@"',
    "  }",
    "fi",
  ],
  env: ["MINMUX_CODEX_ARGS"],
  wslenv: [], // not on Windows (so never in a WSL pane) yet: see codexSpec.windows
}

/** A Codex adapter: `install` writes the drop script and the args file, `env` points panes at
 *  the file. */
export function createCodexAdapter(): AgentAdapter {
  let argsPath: string | null = null
  let trust: Map<string, string> | null = null // our hooks' trust hashes, as Codex records them
  const tokens = new CodexTokens() // per-rollout totals across batches
  return {
    kind: "codex",
    install(cfgDir) {
      const dir = path.join(cfgDir, "agents")
      fs.mkdirSync(dir, { recursive: true })
      // .cjs: CommonJS even under a package.json with "type": "module" further up.
      const drop = path.join(dir, "drop.cjs")
      writeIfChanged(drop, `${HOOK_WRITER}\n`)
      const args = path.join(dir, "codex-args")
      writeIfChanged(args, `${codexHookArgs(drop).join("\n")}\n`)
      trust = codexTrustHashes(drop)
      argsPath = args
    },
    env: (): Record<string, string> => (argsPath ? { MINMUX_CODEX_ARGS: argsPath } : {}),
    normalize: normalizeCodexEvent,
    // Stop → the session's rollout; SubagentStop → the sub-agent's (its hook names it).
    usage: (batch, resolve) => tokenEventsForBatch(tokens, batch, resolve),
    meta: { file: (ev) => codexIndexFor(ev.transcriptPath), reader: threadNameReader },
    // Codex records each trusted hook in its config.toml; read it (async, read-only) and compare.
    approved: async () => {
      if (!trust) return null
      const home = process.env.CODEX_HOME || path.join(os.homedir(), ".codex")
      try {
        return codexApproved(
          await fs.promises.readFile(path.join(home, "config.toml"), "utf8"),
          trust,
        )
      } catch {
        return false // no config.toml yet: nothing trusted
      }
    },
  }
}

export const codexSpec: AgentSpec = {
  kind: "codex",
  windows: false, // its hook shell's quoting there is unverified (MULTI_AGENT.md S1-e)
  shell: codexShell,
  rules: codexSessionRules,
  create: createCodexAdapter,
}
