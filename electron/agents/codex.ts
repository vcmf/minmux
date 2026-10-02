// The Codex CLI adapter (docs/design/MULTI_AGENT.md; spike S1). Codex speaks Claude's hook
// contract (same event names and fields), so its hooks reuse Claude's normaliser. They are
// added per launch with `codex -c hooks.<Event>=[…]` from an rc wrapper: a layer of its own,
// on top of the user's hooks (S1-a), and approved once in Codex's `/hooks` — approval is keyed
// by the definition's hash, so the definition holds no per-launch or per-pane value.

import fs from "node:fs"
import path from "node:path"
import type { AgentEvent, TokenUsage } from "../../src/lib/agent-graph"
import type { LedgerEntry } from "../agent-sessions"
import { posixQuote } from "../../src/lib/shell-quote"
import { tokenEventsForBatch } from "../agent-tokens"
import { HOOK_WRITER } from "../hook-writer"
import { TranscriptFold } from "../transcript-fold"
import { emptyUsage, num } from "../transcript-tokens"
import { findOnPath } from "../path-lookup"
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

/** The `codex` arguments that add our hooks: `-c`, `hooks.<Event>=[…]` pairs. Pure; the same
 *  `dropScript` path always gives the same bytes (Codex's approval is keyed by them). */
export function codexHookArgs(dropScript: string): string[] {
  // `exec`: the shell Codex runs the command in becomes node, so node's parent is Codex
  // itself (the writer records that pid: the lead rule).
  const command = `exec node ${posixQuote(dropScript)} codex`
  const args: string[] = []
  for (const e of EVENTS) {
    const hook =
      `{type="command",command=${toml(command)},timeout=${SHORT.has(e) ? 3 : 5}` +
      (e === "SessionEnd" ? "}" : ",async=true}")
    const entry = TOOL_EVENTS.has(e) ? `{matcher="",hooks=[${hook}]}` : `{hooks=[${hook}]}`
    args.push("-c", `hooks.${e}=[${entry}]`)
  }
  return args
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

/** Fold one index line into the id → name map (pure; latest wins, junk skipped). */
export function addThreadNameLine(
  acc: Map<string, string> | null,
  line: string,
): Map<string, string> | null {
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
  const map = acc ?? new Map<string, string>()
  map.set(r.id, r.thread_name.trim())
  return map
}

/** Codex's meta: the session's thread name, marked automatic — Codex names threads itself and
 *  a user's `/rename` can't be told apart yet (S1-g), so it never colours a pane (D3). */
export const threadNameReader = (): MetaReader => {
  // Keyed by the path the hooks report: fine while Codex runs only on macOS/Linux; with WSL
  // panes, two distros' indexes would share it (key by distro + path then).
  const fold = new TranscriptFold<Map<string, string> | null>(addThreadNameLine, null)
  return {
    update: async (key, candidates, sessionId) => {
      const name = sessionId ? (await fold.update(key, candidates))?.get(sessionId) : undefined
      return name ? { name, auto: true } : {}
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
}

/** Adds our hooks to `codex` while minmux provides the args file (one argument per line, so
 *  quotes and spaces reach Codex intact). Line arrays, reviewed as shell. */
export const codexShell: AgentShell = {
  zsh: [
    "# Add minmux's hooks to `codex` (agents board): one argument per line in the file.",
    'if [[ -o interactive && -n "${MINMUX_CODEX_ARGS-}" ]]; then',
    "  function codex {", // not `codex()`: a user alias `codex` would break the rc
    '    [[ -r "$MINMUX_CODEX_ARGS" ]] || { command codex "$@"; return }',
    '    command codex "${(@f)"$(<"$MINMUX_CODEX_ARGS")"}" "$@"',
    "  }",
    "fi",
  ],
  bash: [
    "# Add minmux's hooks to `codex` (agents board): one argument per line in the file.",
    'if [[ $- == *i* && -n "${MINMUX_CODEX_ARGS-}" ]]; then',
    "  function codex {",
    '    [[ -r "$MINMUX_CODEX_ARGS" ]] || { command codex "$@"; return; }',
    "    local -a __minmux_a=()",
    "    local __minmux_l",
    '    while IFS= read -r __minmux_l || [[ -n "$__minmux_l" ]]; do',
    '      __minmux_a+=("$__minmux_l")',
    '    done < "$MINMUX_CODEX_ARGS"',
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
  const tokens = new CodexTokens() // per-rollout totals across batches
  return {
    kind: "codex",
    install(cfgDir) {
      // The hook runs `node`; Codex itself is a native binary, often installed without it.
      if (!findOnPath("node")) throw new Error("codex: `node` not on PATH, hooks can't run")
      const dir = path.join(cfgDir, "agents")
      fs.mkdirSync(dir, { recursive: true })
      // .cjs: CommonJS even under a package.json with "type": "module" further up.
      const drop = path.join(dir, "drop.cjs")
      writeIfChanged(drop, `${HOOK_WRITER}\n`)
      const args = path.join(dir, "codex-args")
      writeIfChanged(args, `${codexHookArgs(drop).join("\n")}\n`)
      argsPath = args
    },
    env: (): Record<string, string> => (argsPath ? { MINMUX_CODEX_ARGS: argsPath } : {}),
    normalize: normalizeCodexEvent,
    // Stop → the session's rollout; SubagentStop → the sub-agent's (its hook names it).
    usage: (batch, resolve) => tokenEventsForBatch(tokens, batch, resolve),
    meta: { file: (ev) => codexIndexFor(ev.transcriptPath), reader: threadNameReader },
  }
}

/** Replace `file` with `content` atomically (temp + rename), and only when it differs: a
 *  Codex still running from an earlier launch may be reading it for a hook right now. */
function writeIfChanged(file: string, content: string): void {
  try {
    if (fs.readFileSync(file, "utf8") === content) return
  } catch {
    // missing: write it
  }
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, content)
  fs.renameSync(tmp, file)
}

export const codexSpec: AgentSpec = {
  kind: "codex",
  windows: false, // its hook shell's quoting there is unverified (MULTI_AGENT.md S1-e)
  shell: codexShell,
  rules: codexSessionRules,
  create: createCodexAdapter,
}
