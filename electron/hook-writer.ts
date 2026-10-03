// File-drop hook transport. Instead of POSTing to a loopback HTTP server (unreachable
// from WSL, and a source of stale-port ECONNREFUSED spam), each agent runs a `command` hook
// that writes each event's stdin JSON verbatim into a watched directory; minmux's watcher
// (agent-hooks.ts) reads + deletes each file. No ports, no networking — works identically
// on macOS, native Windows, and WSL (which writes into a Windows dir via /mnt/c).

// Runs as `node -e <this> <agent>` (Claude: exec form, no file to relocate for WSL) or as
// `exec node <cfg>/agents/drop.cjs <agent>` (Codex: its hook command is one shell string).
// Reads stdin, writes one uniquely-named file per event into `$MINMUX_AGENT_EVENTS/<agent>/`
// (agent = the LAST argument, so both forms work); the filename is
// `<pane>.<agent pid>.<ts>.<rand>`: MINMUX_PANE_ID tags the pane (the payload has none) and
// the parent pid (the agent process that ran the hook) tells a pane's lead from another
// process's sessions. The drop root comes from the env, never the hook definition, so a
// definition is byte-stable across launches and panes (Codex trusts hooks by their hash) and
// the per-launch root stays out of any file. Outside a minmux pane (no env) it writes nothing.
export const HOOK_WRITER = [
  'const fs=require("fs"),p=require("path");let d="";',
  'process.stdin.on("data",c=>d+=c);',
  'process.stdin.on("end",()=>{try{',
  "const r=process.env.MINMUX_AGENT_EVENTS,a=process.argv[process.argv.length-1];",
  'if(!r||!/^[a-z]+$/.test(a||""))return;',
  'const id=process.env.MINMUX_PANE_ID||"none";',
  'const f=p.join(r,a,id+"."+process.ppid+"."+Date.now()+"."+Math.random().toString(36).slice(2)+".json");',
  "fs.writeFileSync(f,d)}catch(e){}})",
].join("")
