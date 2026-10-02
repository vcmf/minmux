// The Claude Code adapter (docs/design/MULTI_AGENT.md §4.2): how a pane arms `claude`
// (scoped `--settings` hook file, the rc wrapper), how its hook JSON becomes AgentEvents,
// where its tokens come from, and its resume / lead rules. Everything Claude-specific in the
// main process lives here.

import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import type { AgentEvent } from "../../src/lib/agent-graph"
import { cwdMatchesTranscript } from "../../src/lib/claude-project"
import type { LedgerEntry } from "../agent-sessions"
import { tokenEventsForBatch } from "../agent-tokens"
import { HOOK_WRITER } from "../hook-writer"
import { TranscriptMeta } from "../transcript-meta"
import { TranscriptTokens } from "../transcript-tokens"
import type { AgentAdapter, AgentShell, AgentSpec, SessionRules } from "./types"

// Events of interest (unchanged from the HTTP transport). Tool events take a matcher.
const EVENTS = [
  "SessionStart",
  "SessionEnd",
  "UserPromptSubmit",
  "Stop",
  "Notification",
  "SubagentStart",
  "SubagentStop",
  "PreToolUse",
  "PostToolUse",
  "CwdChanged",
  "FileChanged",
  "WorktreeCreate",
  "WorktreeRemove",
]
const TOOL_EVENTS = new Set(["PreToolUse", "PostToolUse"])

/** Claude Code hook-settings JSON that drops each event as a file into
 *  `$MINMUX_AGENT_EVENTS/claude/` via the inline `node -e` writer. Holds no path, so the same
 *  file serves native and WSL panes. Pure — unit-tested. */
export function buildHookSettings(): string {
  // async: don't block the agent's tool loop waiting on the drop; timeout: a hard backstop
  // so a stalled writer (slow/full disk, slow /mnt/c drvfs write) can never hang the agent
  // — the guarantee the old http hook's `timeout: 3` gave (AGENT_OBSERVABILITY §8).
  const hook = {
    type: "command",
    command: "node",
    args: ["-e", HOOK_WRITER, "claude"],
    async: true,
    timeout: 5,
  }
  const hooks: Record<string, unknown[]> = {}
  for (const e of EVENTS)
    hooks[e] = [TOOL_EVENTS.has(e) ? { matcher: "", hooks: [hook] } : { hooks: [hook] }]
  return `${JSON.stringify({ hooks }, null, 2)}\n`
}

// tool_input keys that carry a file path, across the file-touching tools.
const FILE_TOOL_KEYS = ["file_path", "path", "notebook_path"] as const

/** One tool call's identity: its name + a hash of what it runs. An approval prompt carries no
 *  call id, but the same input (Codex adds a `description` to it, left out here), so this
 *  matches a PermissionRequest to its PreToolUse / PostToolUse. Bounded, content-free. */
export function toolCallKey(toolName: string, input: Record<string, unknown>): string {
  const { description, ...rest } = input
  void description
  const what = typeof rest.command === "string" ? rest.command : JSON.stringify(rest)
  return `${toolName}:${createHash("sha1")
    .update(what.slice(0, 64 * 1024))
    .digest("hex")
    .slice(0, 16)}`
}

/** Raw hook JSON (+ the pane id parsed from the drop file's name) → the normalised
 *  AgentEvent; null if the payload lacks the minimum (event name + session id). */
export function normalizeHookEvent(raw: unknown, paneId?: string): AgentEvent | null {
  if (typeof raw !== "object" || raw === null) return null
  const r = raw as Record<string, unknown>
  if (typeof r.hook_event_name !== "string" || typeof r.session_id !== "string") return null
  const ti = (typeof r.tool_input === "object" && r.tool_input ? r.tool_input : {}) as Record<
    string,
    unknown
  >
  const filePath = FILE_TOOL_KEYS.map((k) => ti[k]).find((v) => typeof v === "string") as
    string | undefined
  const str = (v: unknown) => (typeof v === "string" ? v : undefined)
  const toolName = str(r.tool_name)
  return {
    agent: "claude",
    event: r.hook_event_name,
    sessionId: r.session_id,
    paneId: paneId || undefined,
    agentId: str(r.agent_id),
    agentType: str(r.agent_type),
    cwd: str(r.cwd),
    toolName,
    toolKey: toolName && r.tool_input !== undefined ? toolCallKey(toolName, ti) : undefined,
    filePath,
    message: str(r.message) ?? str(r.last_assistant_message),
    worktreePath: str(r.worktree_path),
    baseBranch: str(r.base_branch),
    transcriptPath: str(r.transcript_path),
    agentTranscriptPath: str(r.agent_transcript_path),
    source: str(r.source),
    reason: str(r.reason),
    permissionMode: str(r.permission_mode),
  }
}

// Claude session ids are UUIDs; permission modes are single words. Anything else never
// reaches a command line we type into a shell.
export const SAFE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const SAFE_MODE = /^[A-Za-z]{1,32}$/

/** The resume command for an entry (null if its id can't be trusted). */
export function resumeCommand(e: LedgerEntry, allowBypass: boolean): string | null {
  if (!SAFE_ID.test(e.sessionId)) return null
  const mode = e.permissionMode
  const keepMode =
    mode &&
    SAFE_MODE.test(mode) &&
    mode !== "default" &&
    (mode !== "bypassPermissions" || allowBypass)
  return `claude --resume ${e.sessionId}${keepMode ? ` --permission-mode ${mode}` : ""}`
}

/** Claude's lead + resume rules: only `/clear` or a fork replaces a live lead. */
export const claudeSessionRules: SessionRules = {
  resumeCommand,
  cwdFits: cwdMatchesTranscript,
  isSwitch: (ev) => ev.source === "clear" || ev.source === "fork",
}

/** Routes `claude` through our hook settings while minmux provides them (line arrays). */
export const claudeShell: AgentShell = {
  zsh: [
    "# Route `claude` through minmux's scoped hook settings so the agents board can",
    "# observe its sessions/sub-agents. Only when minmux provides the file; the user's",
    "# global ~/.claude config is untouched. (M6 — docs/design/AGENT_OBSERVABILITY.md)",
    'if [[ -o interactive && -n "${MINMUX_CLAUDE_SETTINGS-}" ]]; then',
    // `function name`, not `name()`: a user alias of the same name would be expanded inside
    // `name() {` and fail the whole rc with a parse error.
    '  function claude { command claude --settings "$MINMUX_CLAUDE_SETTINGS" "$@" }',
    "fi",
  ],
  bash: [
    "# Route `claude` through minmux's scoped hook settings (agents board — M6).",
    'if [[ $- == *i* && -n "${MINMUX_CLAUDE_SETTINGS-}" ]]; then',
    '  function claude { command claude --settings "$MINMUX_CLAUDE_SETTINGS" "$@"; }',
    "fi",
  ],
  env: ["MINMUX_CLAUDE_SETTINGS"],
  wslenv: ["MINMUX_CLAUDE_SETTINGS/p"], // /p path-translates it for claude-in-WSL to read
}

/** A Claude adapter: `install` writes the scoped hook settings, `env` points panes at them. */
export function createClaudeAdapter(): AgentAdapter {
  let settingsPath: string | null = null
  const tokens = new TranscriptTokens() // per-transcript totals across batches
  return {
    kind: "claude",
    install(cfgDir) {
      const p = path.join(cfgDir, "claude-hooks.json")
      fs.writeFileSync(p, buildHookSettings())
      // Older Windows builds also wrote a WSL variant addressing the drop dir via /mnt/c.
      if (process.platform === "win32")
        fs.rmSync(path.join(cfgDir, "claude-hooks.wsl.json"), { force: true })
      settingsPath = p
    },
    env: (): Record<string, string> =>
      settingsPath ? { MINMUX_CLAUDE_SETTINGS: settingsPath } : {},
    normalize: normalizeHookEvent,
    usage: (batch, resolve) => tokenEventsForBatch(tokens, batch, resolve),
    meta: { file: (ev) => ev.transcriptPath ?? null, reader: () => new TranscriptMeta() },
  }
}

export const claudeSpec: AgentSpec = {
  kind: "claude",
  shell: claudeShell,
  rules: claudeSessionRules,
  create: createClaudeAdapter,
}
