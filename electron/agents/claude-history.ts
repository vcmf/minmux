// Claude's past sessions for the Sessions tab: `<config>/projects/<folder>/<id>.jsonl`, read by
// head (folder, first prompt) and tail (the latest /rename), cached per file.

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { LIST_MAX, isTypedPrompt, oneLine } from "../../src/lib/past-sessions"
import { cwdMatchesTranscript } from "../../src/lib/claude-project"
import { addMetaLine, emptyMeta } from "../transcript-meta"
import { FileCache, cwdField, jsonlFiles, mapLimit, parseLine, readHeadTail } from "../history-read"
import type { ListedSession, SessionHistory } from "./types"

const HEAD_BYTES = 64 * 1024
const TAIL_BYTES = 64 * 1024
const UUID_JSONL = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/i
// What Claude puts in the user's turn that the user didn't type: slash-command records, caveats.
const INJECTED = /^(<command-|<local-command-|Caveat: )/

/** The text a user turn carries (a string, or its text blocks), if it's one. */
function userText(o: Record<string, unknown>): string | undefined {
  if (o.type !== "user" || o.isMeta === true || o.isSidechain === true) return undefined
  const content = (o.message as { content?: unknown } | undefined)?.content
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return undefined
  const texts = content
    .filter(
      (b): b is { type: "text"; text: string } => b?.type === "text" && typeof b.text === "string",
    )
    .map((b) => b.text)
  return texts.length ? texts.join(" ") : undefined
}

/** Could this raw line be a typed prompt or a reply? (a tool's result or call never is) */
export const claudeQuick = (raw: string): boolean =>
  (raw.includes('"type":"user"') && !raw.includes('"tool_result"')) ||
  (raw.includes('"type":"assistant"') && raw.includes('"type":"text"'))

/** What the user and Claude wrote on this line (typed prompts, replies), for search. */
export function claudeTexts(o: Record<string, unknown>): string[] {
  const user = userText(o)
  if (user !== undefined) return isTypedPrompt(user, INJECTED) ? [user] : []
  if (o.type !== "assistant" || o.isSidechain === true) return []
  const content = (o.message as { content?: unknown } | undefined)?.content
  if (!Array.isArray(content)) return []
  return content
    .filter(
      (b): b is { type: "text"; text: string } => b?.type === "text" && typeof b.text === "string",
    )
    .map((b) => b.text)
}

// With the transcript's path, the folder is the first one Claude files the session under: a
// nested or background claude may log another `cwd` first, and `--resume` only finds it there.
/** From a transcript's start: where it ran and the first prompt the user typed. */
export function claudeHead(
  text: string,
  transcriptPath?: string,
): { cwd?: string; firstPrompt?: string } {
  let first: string | undefined
  let fits: string | undefined
  let firstPrompt: string | undefined
  for (const line of text.split("\n")) {
    if (fits && firstPrompt) break
    // Cheap pre-filter: most lines are neither.
    if (!line.includes('"cwd"') && !line.includes('"type":"user"')) continue
    const o = parseLine(line)
    if (!o) continue
    if (typeof o.cwd === "string" && o.cwd) {
      first ??= o.cwd
      if (!fits && transcriptPath && cwdMatchesTranscript(o.cwd, transcriptPath) !== false)
        fits = o.cwd
    }
    if (!firstPrompt) {
      const t = userText(o)
      if (t !== undefined && isTypedPrompt(t, INJECTED)) firstPrompt = oneLine(t)
    }
  }
  // None fits: the first, and resume says why it can't (its folder doesn't match the session).
  return { cwd: fits ?? first ?? cwdField(text), firstPrompt }
}

/** From anywhere in a transcript (head, then tail): its latest /rename and last prompt. */
export function claudeNames(text: string): { name?: string; lastPrompt?: string } {
  let meta = emptyMeta
  let lastPrompt: string | undefined
  for (const line of text.split("\n")) {
    meta = addMetaLine(meta, line)
    if (line.includes('"last-prompt"')) {
      const o = parseLine(line)
      if (
        o?.type === "last-prompt" &&
        typeof o.lastPrompt === "string" &&
        isTypedPrompt(o.lastPrompt, INJECTED)
      )
        lastPrompt = oneLine(o.lastPrompt)
    }
  }
  return { name: meta.name ? oneLine(meta.name) : undefined, lastPrompt }
}

/** Claude's config dir (where `projects/` is). */
export const claudeHome = () => process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude")

/** Claude's sessions, newest first (`root` = its config dir). */
export function claudeHistory(root = claudeHome): SessionHistory {
  const cache = new FileCache<ListedSession | null>()
  return {
    async list() {
      const projects = path.join(root(), "projects")
      let dirs: string[]
      try {
        dirs = await fs.promises.readdir(projects)
      } catch {
        return [] // Claude never ran here
      }
      // Top level only: `<id>/subagents/` holds sub-agent transcripts, not sessions to resume.
      const files = (await mapLimit(dirs, 8, (d) => jsonlFiles(path.join(projects, d))))
        .flatMap((f) => f ?? [])
        .filter((f) => UUID_JSONL.test(path.basename(f.file)))
        .sort((a, b) => b.mtimeMs - a.mtimeMs)
        .slice(0, LIST_MAX)
      cache.keepOnly(new Set(files.map((f) => f.file)))
      const rows = await mapLimit(files, 8, async (f) => {
        const hit = cache.get(f.file, f.size, f.mtimeMs)
        if (hit !== undefined) return hit
        const { head, tail } = await readHeadTail(f.file, f.size, HEAD_BYTES, TAIL_BYTES)
        const { cwd, firstPrompt } = claudeHead(head, f.file)
        const { name, lastPrompt } = claudeNames(head + tail)
        // Nothing to call it by (a session closed before its first prompt): not listed.
        const row: ListedSession | null =
          name || firstPrompt || lastPrompt
            ? {
                agent: "claude",
                sessionId: path.basename(f.file, ".jsonl"),
                updatedAt: f.mtimeMs,
                transcriptPath: f.file,
                ...(name ? { name } : {}),
                ...(firstPrompt || lastPrompt ? { firstPrompt: firstPrompt ?? lastPrompt } : {}),
                ...(cwd ? { cwd } : {}),
              }
            : null
        cache.set(f.file, f.size, f.mtimeMs, row)
        return row
      })
      return rows.filter((r): r is ListedSession => !!r)
    },
  }
}
