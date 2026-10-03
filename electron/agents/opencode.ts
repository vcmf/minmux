// OpenCode: minmux's plugin, added through OPENCODE_CONFIG_CONTENT (MULTI_AGENT.md F1, S2),
// writes its own drops; the normaliser maps them onto the canonical events.

import fs from "node:fs"
import path from "node:path"
import { pathToFileURL } from "node:url"
import type { AgentEvent } from "../../src/lib/agent-graph"
import { writeIfChanged } from "./files"
import { OPENCODE_DROP_VERSION, OPENCODE_PLUGIN } from "./opencode-plugin"
import type { AgentAdapter, AgentShell, AgentSpec, SessionRules } from "./types"

/** The plugin's file name: also how a stale copy from another minmux is recognised. */
export const PLUGIN_FILE = "minmux-opencode.js"

const isMinmuxPlugin = (v: unknown) =>
  typeof v === "string" && /[\\/]agents[\\/]minmux-opencode\.js$/.test(v)

/** OPENCODE_CONFIG_CONTENT without any minmux's plugin (a minmux started from a minmux pane):
 *  undefined when nothing of the user's is left; unchanged when it can't be read. */
export function stripMinmuxPlugins(value: string): string | undefined {
  let cfg: unknown
  try {
    cfg = JSON.parse(value)
  } catch {
    return value
  }
  if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) return value
  const o = cfg as Record<string, unknown>
  if (!Array.isArray(o.plugin) || !o.plugin.some(isMinmuxPlugin)) return value
  const plugin = o.plugin.filter((p) => !isMinmuxPlugin(p))
  const rest = { ...o, plugin }
  if (plugin.length === 0) delete (rest as Record<string, unknown>).plugin
  return Object.keys(rest).length ? JSON.stringify(rest) : undefined
}

/** The user's OPENCODE_CONFIG_CONTENT with our plugin first (theirs kept, another minmux's
 *  dropped). undefined = leave theirs as it is: not an object, unparseable, or a `plugin` that
 *  isn't a list (OpenCode would reject ours alongside it anyway). */
export function mergeOpencodeConfig(existing: string | undefined, url: string): string | undefined {
  const theirs = existing?.trim() ? stripMinmuxPlugins(existing) : undefined
  if (theirs === undefined) return JSON.stringify({ plugin: [url] })
  let cfg: unknown
  try {
    cfg = JSON.parse(theirs)
  } catch {
    return undefined
  }
  if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) return undefined
  const o = cfg as Record<string, unknown>
  if (o.plugin !== undefined && !Array.isArray(o.plugin)) return undefined
  return JSON.stringify({ ...o, plugin: [url, ...((o.plugin as unknown[] | undefined) ?? [])] })
}

// Our plugin in OPENCODE_CONFIG_CONTENT at launch, even when the user's rc or direnv set their
// own after minmux did. No JSON tool in a shell: an object's `"plugin": [` list gets ours first,
// an object without one gets the key; anything else is left alone (MULTI_AGENT.md F1). Known
// limit: it splits on the first `"plugin"` text, so one nested deeper (no OpenCode key nests
// one) would take ours instead of the top-level list.
// zsh and bash share these lines.
const MERGE = [
  "  function __minmux_oc_config {",
  '    local s="${OPENCODE_CONFIG_CONTENT-}" u="\\"$MINMUX_OPENCODE_PLUGIN\\"" k=\'"plugin"\' t r pre',
  '    __minmux_oc="$s"',
  '    [[ "$s" == *"$u"* ]] && return 0',
  '    t="${s#"${s%%[![:space:]]*}"}"',
  '    if [[ -z "$t" ]]; then __minmux_oc="{\\"plugin\\":[$u]}"; return 0; fi',
  '    [[ "$t" == "{"* ]] || return 0',
  '    if [[ "$s" == *"$k"* ]]; then',
  '      pre="${s%%"$k"*}" r="${s#*"$k"}"',
  '      r="${r#"${r%%[![:space:]]*}"}"; [[ "$r" == :* ]] || return 0; r="${r#:}"',
  '      r="${r#"${r%%[![:space:]]*}"}"; [[ "$r" == "["* ]] || return 0; r="${r#"["}"',
  '      t="${r#"${r%%[![:space:]]*}"}"',
  '      if [[ "$t" == "]"* ]]; then __minmux_oc="$pre\\"plugin\\":[$u$r"',
  '      else __minmux_oc="$pre\\"plugin\\":[$u,$r"; fi',
  "    else",
  '      r="${t#"{"}"; t="${r#"${r%%[![:space:]]*}"}"',
  '      if [[ "$t" == "}"* ]]; then __minmux_oc="{\\"plugin\\":[$u]$r"',
  '      else __minmux_oc="{\\"plugin\\":[$u],$r"; fi',
  "    fi",
  "  }",
  "  function opencode {", // not `opencode()`: a user alias `opencode` would break the rc
  "    local __minmux_oc",
  "    __minmux_oc_config",
  '    OPENCODE_CONFIG_CONTENT="$__minmux_oc" command opencode "$@"',
  "  }",
]

export const opencodeShell: AgentShell = {
  zsh: [
    "# Keep minmux's plugin in OpenCode's inline config (agents board), whatever set it last.",
    'if [[ -o interactive && -n "${MINMUX_OPENCODE_PLUGIN-}" ]]; then',
    ...MERGE,
    "fi",
  ],
  bash: [
    "# Keep minmux's plugin in OpenCode's inline config (agents board), whatever set it last.",
    'if [[ $- == *i* && -n "${MINMUX_OPENCODE_PLUGIN-}" ]]; then',
    ...MERGE,
    "fi",
  ],
  env: ["MINMUX_OPENCODE_PLUGIN"],
  merged: { OPENCODE_CONFIG_CONTENT: stripMinmuxPlugins }, // theirs plus ours
  wslenv: [], // not on Windows (so never in a WSL pane) yet: see opencodeSpec.windows
}

// By process (MULTI_AGENT.md §4.4): the plugin starts a root whenever it becomes the active one,
// so a start from the leading OpenCode is a switch; another process's session is nested.
// Sub-agents never start sessions (they're SubagentStart). Resume comes with PR #11.
export const opencodeSessionRules: SessionRules = {
  resumeCommand: () => null,
  cwdFits: () => undefined,
  isSwitch: (ev, lead) => ev.pid !== undefined && ev.pid === lead.pid,
  liveByPid: true, // the plugin's own process.pid: OpenCode fires nothing on quit
}

const ID = /^[A-Za-z0-9_-]{1,128}$/
const id = (v: unknown) => (typeof v === "string" && ID.test(v) ? v : undefined)
const text = (v: unknown, max = 4096) =>
  typeof v === "string" && v.length > 0 ? v.slice(0, max) : undefined
/** A child's type, from the title OpenCode gives it: `"… (@general subagent)"` → `general`. */
const childType = (title: unknown) =>
  typeof title === "string" ? /\(@([\w.-]{1,64}) subagent\)\s*$/.exec(title)?.[1] : undefined

/** One plugin drop → a canonical event (or null). Children are sub-agents of their root
 *  session (nested under their parent when that isn't the root). Never throws. */
export function normalizeOpencodeDrop(raw: unknown, paneId?: string): AgentEvent | null {
  if (!raw || typeof raw !== "object") return null
  const d = raw as Record<string, unknown>
  if (d.v !== OPENCODE_DROP_VERSION) return null
  const sid = id(d.sessionID)
  if (!sid) return null
  const root = id(d.rootID)
  const child = !!root && root !== sid
  const parent = id(d.parentID)
  if (parent && !child) return null // a child whose root the plugin can't name: never a root
  const base: AgentEvent = child
    ? {
        event: "",
        sessionId: root,
        paneId,
        agentId: sid,
        ...(parent && parent !== root ? { parentAgentId: parent } : {}),
      }
    : { event: "", sessionId: sid, paneId, cwd: text(d.directory) }
  const at = (event: AgentEvent["event"], more: Partial<AgentEvent> = {}): AgentEvent => ({
    ...base,
    ...more,
    event,
  })
  const tool = { toolName: text(d.tool, 128) }
  switch (d.e) {
    case "end":
      return child ? null : at("SessionEnd", { reason: "switch" }) // a root the user left
    case "start":
      if (child) return at("SubagentStart", { agentType: childType(d.title) })
      return base.cwd
        ? at("SessionStart", { source: d.source === "new" ? "startup" : "resume" })
        : null
    case "status":
      if (d.status === "busy") return at(child ? "SubagentStart" : "UserPromptSubmit")
      if (d.status === "idle")
        return at(child ? "SubagentStop" : "Stop", { message: text(d.reply) })
      return null
    case "tool": {
      const paths = Array.isArray(d.paths) ? d.paths : []
      const more = { ...tool, toolKey: text(d.callID, 128), filePath: text(paths[0]) }
      if (d.phase === "start") return at("PreToolUse", more)
      return d.phase === "end" ? at("PostToolUse", more) : null
    }
    case "permission": {
      // Keyed by the call (its finishing ends the wait too; the plugin gives a reply its ask's
      // call), else by the request.
      const key = { toolKey: text(d.callID, 128) ?? text(d.requestID, 128) }
      if (d.phase === "asked") return at("PermissionRequest", { ...tool, ...key })
      return d.phase === "replied" ? at("PermissionReplied", key) : null
    }
    default:
      return null // `started`, `session` (titles: PR #10), anything newer
  }
}

/** An OpenCode adapter: `install` writes the plugin, `env` adds it to OpenCode's inline config. */
export function createOpencodeAdapter(): AgentAdapter {
  let url: string | null = null
  return {
    kind: "opencode",
    install(cfgDir) {
      const dir = path.join(cfgDir, "agents")
      fs.mkdirSync(dir, { recursive: true })
      const file = path.join(dir, PLUGIN_FILE)
      writeIfChanged(file, OPENCODE_PLUGIN)
      url = pathToFileURL(file).href
    },
    env: (): Record<string, string> => {
      if (!url) return {}
      const merged = mergeOpencodeConfig(process.env.OPENCODE_CONFIG_CONTENT, url)
      // A config of the user's we can't add to: theirs wins, and the rc wrapper leaves it too.
      return merged === undefined
        ? {}
        : { OPENCODE_CONFIG_CONTENT: merged, MINMUX_OPENCODE_PLUGIN: url }
    },
    normalize: normalizeOpencodeDrop,
  }
}

export const opencodeSpec: AgentSpec = {
  kind: "opencode",
  windows: false, // a Windows path in a file: URL, and WSL forwarding, are unverified
  shell: opencodeShell,
  rules: opencodeSessionRules,
  create: createOpencodeAdapter,
}
