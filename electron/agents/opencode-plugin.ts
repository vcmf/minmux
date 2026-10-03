// minmux's OpenCode plugin, as the source minmux writes into its config dir at launch and adds
// to OpenCode through OPENCODE_CONFIG_CONTENT (MULTI_AGENT.md F1/F2, S2). Kept as reviewable
// text: it runs INSIDE OpenCode, so it filters first, never awaits, and writes a projection
// (ids, status, tool names, paths, title, a bounded last reply), never prompt, file or tool
// content. Inert without minmux's pane env. Plain JS: no `${` or backticks below.

/** Drop format version: the normaliser rejects others. */
export const OPENCODE_DROP_VERSION = 1

export const OPENCODE_PLUGIN = String.raw`// minmux's OpenCode plugin (written by minmux; see minmux's electron/agents/opencode-plugin.ts).
// Reports this OpenCode's sessions to minmux's agents board. Does nothing outside a minmux pane.
import fs from "node:fs"
import path from "node:path"

const V = 1
const MAX_REPLY = 2000
const MAX_TEXT = 256
const MAX_PATH = 4096
const MAX_SESSIONS = 256 // per process; the oldest go first
const MAX_PATCH_SCAN = 256 * 1024
const PATCH_FILE = /^\*\*\* (?:Add|Update|Delete) File: (.+?)\r?$/gm
const LOADED = Symbol.for("minmux.opencode")
// Per process, across instances (OpenCode calls the factory per project and on a reload).
let last = 0
let seq = 0
const ON = new Set([
  "session.created",
  "session.updated",
  "session.status",
  "session.idle",
  "message.updated",
  "message.part.updated",
  "permission.asked",
  "permission.replied",
])

const str = (v, max) => (typeof v === "string" && v.length > 0 ? v.slice(0, max) : undefined)

// The files a tool call writes or reads: an edit's filePath, a patch's file headers (never a
// search tool's path: that's a folder).
const touched = (args) => {
  const file = str(args.filePath, MAX_PATH)
  if (file) return [file]
  const patch = typeof args.patchText === "string" ? args.patchText.slice(0, MAX_PATCH_SCAN) : ""
  const out = []
  for (const m of patch.matchAll(PATCH_FILE)) if (out.length < 32) out.push(m[1].slice(0, MAX_PATH))
  return out
}

export const MinmuxPlugin = async (ctx) => {
  const root = process.env.MINMUX_AGENT_EVENTS
  const pane = process.env.MINMUX_PANE_ID
  if (!root || !pane || !/^[A-Za-z0-9_-]+$/.test(pane)) return {}
  // One copy per process: another minmux's (a different file, inherited) stays quiet. This
  // copy may be called again (another project, a reload): each call gets its own hooks.
  if (globalThis[LOADED] && globalThis[LOADED] !== import.meta.url) return {}
  globalThis[LOADED] = import.meta.url
  const dir = path.join(root, "opencode")
  const base = str(ctx && ctx.directory, MAX_PATH)
  // Fire and forget: temp + rename (minmux only reads *.json), never awaited by a handler.
  const drop = (o) => {
    const ts = Math.max(Date.now(), last + 1) // strictly increasing: minmux orders drops by it
    last = ts
    const name = pane + "." + process.pid + "." + ts + "." + (seq++).toString(36)
    const tmp = path.join(dir, "." + name + ".tmp")
    fs.promises
      .writeFile(tmp, JSON.stringify(Object.assign({ v: V }, o)))
      .then(() => fs.promises.rename(tmp, path.join(dir, name + ".json")))
      .catch(() => {})
  }

  const sessions = new Map() // id → { parentID, directory, title, status }
  const asks = new Map() // permission request id → the tool call it's for
  const assistant = new Map() // session id → its latest assistant message id
  const reply = new Map() // session id → that message's latest text (bounded when sent)
  const capped = (m, k, v) => {
    if (!m.has(k) && m.size >= MAX_SESSIONS) m.delete(m.keys().next().value)
    m.set(k, v)
  }
  // Full: the least recently used sub-agent goes first (every one is a session of its own), so
  // a long run never loses the roots the user works in; only if all are roots, the oldest root.
  // Never one still in use: busy, the active root, or one /new left that ends at idle.
  const evict = () => {
    const kept = (k, v) => k === active || v.left || v.status === "busy"
    for (const [k, v] of sessions) if (v.parentID && !kept(k, v)) return sessions.delete(k)
    for (const [k, v] of sessions) if (!kept(k, v)) return sessions.delete(k)
    sessions.delete(sessions.keys().next().value)
  }
  const session = (id) => {
    let s = sessions.get(id)
    if (s) sessions.delete(id)
    else if (sessions.size >= MAX_SESSIONS) evict()
    sessions.set(id, (s = s || {}))
    return s
  }
  // A child's root: its parent chain's top (sub-agents can nest with custom agents).
  // undefined when a link in the chain is unknown (never seen, or evicted): never a guess.
  const rootOf = (id) => {
    let cur = id
    for (let i = 0; i < 16; i++) {
      const p = sessions.get(cur) && sessions.get(cur).parentID
      if (!p) return cur
      if (!sessions.has(p)) return undefined
      cur = p
    }
    return undefined
  }
  // A child names its parent and root; a root its folder (so a session first seen mid-life
  // still files). A lookup: it never adds a session.
  const where = (id) => {
    const s = sessions.get(id) || {}
    return s.parentID
      ? { parentID: s.parentID, rootID: rootOf(id) }
      : { directory: s.directory || base }
  }
  // A "start" before a session's activity: a child's first sight; a root's whenever the user
  // moves to it (new, picked in /sessions, --session, back after /new), i.e. its own new
  // turn, never a background session's tools. Only once its info is known (a prompt brings
  // session.updated before busy): an unknown session may be a child.
  let active
  const begin = (id, activate) => {
    const s = session(id)
    if (!s.seen) return
    if (s.parentID) {
      const root = rootOf(id)
      if (!root) return
      begin(root)
      if (s.started) return
      s.started = true
      return drop(Object.assign({ e: "start", sessionID: id, title: s.title }, where(id)))
    }
    // A root starts only when the user moves to it: never on a background session's tools.
    if (!activate || active === id) return
    const left = active
    active = id
    const source = activate === "new" ? "new" : "seen"
    drop({ e: "start", sessionID: id, source, directory: s.directory || base })
    if (left && activate === "new") leave(left)
  }
  // The root /new left is over once idle (a still-running one: when its turn does). Not on a
  // turn starting elsewhere: that may be a queued prompt, not the user moving. Picked again, it
  // starts again with the user's next prompt there (picking a busy one sends nothing).
  const leave = (id) => {
    const s = sessions.get(id)
    if (!s || active === id) return
    if (s.status === "busy") s.left = true
    else {
      s.left = false
      drop(Object.assign({ e: "end", sessionID: id }, where(id)))
    }
  }
  const onSession = (info, created) => {
    const id = str(info && info.id, MAX_TEXT)
    if (!id) return
    const s = session(id)
    const parentID = str(info.parentID, MAX_TEXT)
    const directory = str(info.directory, MAX_PATH)
    const title = str(info.title, MAX_TEXT)
    if (s.seen && s.parentID === parentID && s.directory === directory && s.title === title) return
    Object.assign(s, { seen: true, parentID, directory, title })
    if (created) begin(id, "new")
    drop(Object.assign({ e: "session", sessionID: id, title }, where(id)))
  }
  const onStatus = (id, status) => {
    if (!id || (status !== "busy" && status !== "idle")) return
    const s = session(id)
    if (s.status === status) return // reported on change only
    s.status = status
    if (status === "busy") begin(id, "turn")
    const o = Object.assign({ e: "status", sessionID: id, status }, where(id))
    if (status === "idle") {
      const text = reply.get(id)
      if (typeof text === "string" && text.trim()) o.reply = text.slice(0, MAX_REPLY)
      reply.delete(id)
    }
    drop(o)
    if (status === "idle" && s.left) leave(id)
  }
  const onTool = (phase, input, output) => {
    const id = str(input && input.sessionID, MAX_TEXT)
    if (!id) return
    const args = (output && output.args) || {}
    const o = { e: "tool", phase, sessionID: id, tool: str(input.tool, MAX_TEXT) }
    o.callID = str(input.callID, MAX_TEXT)
    const paths = touched(args)
    if (paths.length) o.paths = paths
    if (phase === "start") begin(id)
    drop(Object.assign(o, where(id)))
  }

  drop({ e: "started", directory: base })
  return {
    event: (input) => {
      try {
        const event = input && input.event
        if (!event || !ON.has(event.type)) return
        const p = event.properties || {}
        switch (event.type) {
          case "message.part.updated": {
            // The hot one (every streamed chunk): a map lookup, a reference kept, no copy.
            const part = p.part
            if (part && part.type === "text" && !part.synthetic && assistant.get(part.sessionID) === part.messageID)
              capped(reply, part.sessionID, part.text)
            return
          }
          case "message.updated": {
            const m = p.info
            if (m && m.role === "assistant" && typeof m.sessionID === "string") capped(assistant, m.sessionID, m.id)
            return
          }
          case "session.created":
          case "session.updated":
            return onSession(p.info, event.type === "session.created")
          case "session.status": {
            const t = p.status && p.status.type
            return onStatus(str(p.sessionID, MAX_TEXT), t === "retry" ? "busy" : t)
          }
          case "session.idle":
            return onStatus(str(p.sessionID, MAX_TEXT), "idle")
          case "permission.asked":
          case "permission.replied": {
            const id = str(p.sessionID, MAX_TEXT)
            if (!id) return
            const phase = event.type === "permission.asked" ? "asked" : "replied"
            const o = { e: "permission", phase, sessionID: id, tool: str(p.permission, MAX_TEXT) }
            o.requestID = str(p.id, MAX_TEXT) || str(p.requestID, MAX_TEXT) // which ask a reply answers
            // The call it's for (a reply doesn't say: the ask did).
            o.callID = str(p.tool && p.tool.callID, MAX_TEXT) || asks.get(o.requestID)
            if (phase === "asked" && o.requestID && o.callID) capped(asks, o.requestID, o.callID)
            else if (phase === "replied") asks.delete(o.requestID)
            if (phase === "asked") begin(id)
            return drop(Object.assign(o, where(id)))
          }
        }
      } catch {
        // never into OpenCode
      }
    },
    "tool.execute.before": (input, output) => {
      try {
        onTool("start", input, output)
      } catch {}
    },
    "tool.execute.after": (input) => {
      try {
        onTool("end", input)
      } catch {}
    },
  }
}
`
