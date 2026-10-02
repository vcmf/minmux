// The Codex CLI adapter (docs/design/MULTI_AGENT.md; spike S1). Codex speaks Claude's hook
// contract (same event names and fields), so its hooks reuse Claude's normaliser. They are
// added per launch with `codex -c hooks.<Event>=[…]` from an rc wrapper: a layer of its own,
// on top of the user's hooks (S1-a), and approved once in Codex's `/hooks` — approval is keyed
// by the definition's hash, so the definition holds no per-launch or per-pane value.

import fs from "node:fs"
import path from "node:path"
import type { AgentEvent } from "../../src/lib/agent-graph"
import type { LedgerEntry } from "../agent-sessions"
import { posixQuote } from "../../src/lib/shell-quote"
import { HOOK_WRITER } from "../hook-writer"
import { findOnPath } from "../path-lookup"
import { normalizeHookEvent, SAFE_ID } from "./claude"
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
