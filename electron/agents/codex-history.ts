// Codex's past sessions for the Sessions tab: `<home>/sessions/YYYY/MM/DD/rollout-<ts>-<id>.jsonl`
// (head: `session_meta` with the folder, then the first prompt) and `<home>/session_index.jsonl`
// (thread names). Archived sessions (`archived_sessions/`) aren't listed.

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { LIST_MAX, isTypedPrompt, oneLine } from "../../src/lib/past-sessions"
import { FileCache, cwdField, jsonlFiles, mapLimit, parseLine, readHeadTail } from "../history-read"
import type { ListedSession, SessionHistory } from "./types"

// `session_meta` carries Codex's base instructions (~23 KB); the first prompt follows its
// injected developer and environment messages (~60 KB in).
const HEAD_BYTES = 128 * 1024
const ROLLOUT =
  /^rollout-.*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i

// What Codex puts in the user's turn that the user didn't type: its environment, the repo's
// AGENTS.md and instructions, an interrupted turn's marker, a tool's message.
const INJECTED =
  /^(<environment_context|<user_instructions|<turn_aborted|<send_user_message|# AGENTS\.md instructions)/
// Blocks inside a typed message that aren't its text (a pasted image's markers).
const NOT_TEXT = /^<\/?image\b/
// The IDE extension sends its context first, then the user's request under this heading.
const IDE_CONTEXT = "# Context from my IDE setup"
const IDE_REQUEST = "## My request for Codex:"

/** A user turn's own words: an IDE extension's request taken out of its context block. */
export function typedText(text: string): string | undefined {
  const t = text.trimStart()
  if (!t.startsWith(IDE_CONTEXT)) return t
  const at = t.indexOf(IDE_REQUEST)
  return at < 0 ? undefined : t.slice(at + IDE_REQUEST.length)
}

/** `session_index.jsonl` → per thread id its latest name and update time. */
export function codexIndex(text: string): Map<string, { name?: string; updatedAt?: number }> {
  const out = new Map<string, { name?: string; updatedAt?: number }>()
  for (const line of text.split("\n")) {
    if (!line.includes('"id"')) continue
    const o = parseLine(line)
    if (!o || typeof o.id !== "string") continue
    const name = typeof o.thread_name === "string" ? oneLine(o.thread_name) : undefined
    const at = typeof o.updated_at === "string" ? Date.parse(o.updated_at) : NaN
    out.set(o.id, { name, updatedAt: Number.isFinite(at) ? at : undefined })
  }
  return out
}

/** The text of a user message (`response_item` or `event_msg`), if the line is one. */
function userText(o: Record<string, unknown>): string | undefined {
  const p = o.payload as Record<string, unknown> | undefined
  if (!p) return undefined
  if (o.type === "event_msg" && p.type === "user_message" && typeof p.message === "string")
    return p.message
  if (o.type !== "response_item" || p.type !== "message" || p.role !== "user") return undefined
  if (!Array.isArray(p.content)) return undefined
  const texts = (p.content as { type?: unknown; text?: unknown }[])
    .filter((b) => b?.type === "input_text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .filter((t) => !NOT_TEXT.test(t.trimStart()))
  return texts.length ? typedText(texts.join(" ")) : undefined
}

/** From a rollout's start: where it ran and the first prompt the user typed. */
export function codexHead(text: string): { cwd?: string; firstPrompt?: string } {
  let cwd: string | undefined
  let firstPrompt: string | undefined
  for (const line of text.split("\n")) {
    if (cwd && firstPrompt) break
    if (!line.includes('"session_meta"') && !line.includes('"user')) continue
    const o = parseLine(line)
    if (!o) continue
    if (!cwd && o.type === "session_meta") {
      const c = (o.payload as { cwd?: unknown } | undefined)?.cwd
      if (typeof c === "string" && c) cwd = c
    }
    if (!firstPrompt) {
      const t = userText(o)
      if (t !== undefined && isTypedPrompt(t, INJECTED)) firstPrompt = oneLine(t)
    }
  }
  return { cwd: cwd ?? cwdField(text), firstPrompt }
}

/** Every rollout under `sessions/` (YYYY/MM/DD), with its size and mtime. */
async function rollouts(dir: string) {
  const sub = async (d: string) => {
    try {
      return (await fs.promises.readdir(d, { withFileTypes: true }))
        .filter((e) => e.isDirectory())
        .map((e) => path.join(d, e.name))
    } catch {
      return []
    }
  }
  const days = (
    await mapLimit(await sub(dir), 8, async (y) =>
      (await mapLimit(await sub(y), 8, sub)).flatMap((m) => m ?? []),
    )
  ).flatMap((d) => d ?? [])
  return (await mapLimit(days, 8, jsonlFiles)).flatMap((f) => f ?? [])
}

/** Codex's home (CODEX_HOME, else ~/.codex). */
export const codexHome = () => process.env.CODEX_HOME || path.join(os.homedir(), ".codex")

/** Codex's sessions, newest first (`home` = its CODEX_HOME). */
export function codexHistory(home = codexHome): SessionHistory {
  const heads = new FileCache<{ cwd?: string; firstPrompt?: string }>()
  return {
    async list() {
      const root = home()
      const [files, indexText] = await Promise.all([
        rollouts(path.join(root, "sessions")),
        fs.promises.readFile(path.join(root, "session_index.jsonl"), "utf8").catch(() => ""),
      ])
      const index = codexIndex(indexText)
      const recent = files
        .filter((f) => ROLLOUT.test(path.basename(f.file)))
        .sort((a, b) => b.mtimeMs - a.mtimeMs)
        .slice(0, LIST_MAX)
      heads.keepOnly(new Set(recent.map((f) => f.file)))
      const rows = await mapLimit(recent, 8, async (f) => {
        let head = heads.get(f.file, f.size, f.mtimeMs)
        if (!head) {
          head = codexHead((await readHeadTail(f.file, f.size, HEAD_BYTES)).head)
          heads.set(f.file, f.size, f.mtimeMs, head)
        }
        const sessionId = ROLLOUT.exec(path.basename(f.file))![1]!
        const ix = index.get(sessionId)
        // Opened and closed without a prompt (the whole file read, none in it): not listed. A
        // prompt past the head (a big AGENTS.md before it) lists it untitled.
        if (!ix?.name && !head.firstPrompt && f.size <= HEAD_BYTES) return null
        const row: ListedSession = {
          agent: "codex",
          sessionId,
          transcriptPath: f.file,
          updatedAt: Math.max(f.mtimeMs, ix?.updatedAt ?? 0),
          ...(ix?.name ? { name: ix.name } : {}),
          ...(head.firstPrompt ? { firstPrompt: head.firstPrompt } : {}),
          ...(head.cwd ? { cwd: head.cwd } : {}),
        }
        return row
      })
      return rows.filter((r): r is ListedSession => !!r)
    },
  }
}
