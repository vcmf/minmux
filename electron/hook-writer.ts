// File-drop hook transport. Instead of POSTing to a loopback HTTP server (unreachable
// from WSL, and a source of stale-port ECONNREFUSED spam), Claude runs a `command` hook
// that writes each event's stdin JSON verbatim into a watched directory; minmux's watcher
// (agent-hooks.ts) reads + deletes each file. No ports, no networking — works identically
// on macOS, native Windows, and WSL (which writes into a Windows dir via /mnt/c).

// Inline `node -e` (exec form) so there's no separate script file to relocate for WSL —
// `node` is always present where `claude` runs. Reads stdin, writes one uniquely-named
// file per event into argv[1]; the filename is prefixed with MINMUX_PANE_ID so the watcher
// can tag which pane the event came from (the payload itself has no pane id).
export const HOOK_WRITER = [
  'const fs=require("fs"),p=require("path");let d="";',
  'process.stdin.on("data",c=>d+=c);',
  'process.stdin.on("end",()=>{try{',
  'const id=process.env.MINMUX_PANE_ID||"none";',
  'const f=p.join(process.argv[1],id+"."+process.pid+"."+Date.now()+"."+Math.random().toString(36).slice(2)+".json");',
  "fs.writeFileSync(f,d)}catch(e){}})",
].join("")

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

/** Claude Code hook-settings JSON that drops each event as a file into `eventsDir`
 *  via the inline `node -e` writer. Pure — unit-tested. `eventsDir` is the path as the
 *  agent sees it (a host path for native, a /mnt/c path for a WSL settings variant). */
export function buildHookSettings(eventsDir: string): string {
  // async: don't block the agent's tool loop waiting on the drop; timeout: a hard backstop
  // so a stalled writer (slow/full disk, slow /mnt/c drvfs write) can never hang the agent
  // — the guarantee the old http hook's `timeout: 3` gave (AGENT_OBSERVABILITY §8).
  const hook = {
    type: "command",
    command: "node",
    args: ["-e", HOOK_WRITER, eventsDir],
    async: true,
    timeout: 5,
  }
  const hooks: Record<string, unknown[]> = {}
  for (const e of EVENTS)
    hooks[e] = [TOOL_EVENTS.has(e) ? { matcher: "", hooks: [hook] } : { hooks: [hook] }]
  return `${JSON.stringify({ hooks }, null, 2)}\n`
}
