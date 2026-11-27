// Claude Code's transcript as chat items (the phone's chat view). Best-effort over an internal
// format: unknown records are skipped. Sub-agents' lines (isSidechain) stay out of the main thread.

import { clip, questionsOf, RESULT_MAX, TEXT_MAX } from "../../src/lib/remote-chat"
import { JsonlChat, type ChatLog, type ChatReader } from "./chat-log"

const str = (v: unknown): string => (typeof v === "string" ? v : "")
// Text Claude Code puts in the user's turn that the user didn't type.
const NOT_TYPED =
  /^\s*<(command-|local-command-|system-reminder|bash-|user-memory|task-notification)/

/** One line describing a tool call (the command, the file, the pattern…). */
export function toolSummary(name: string, input: unknown): string {
  const o = (input ?? {}) as Record<string, unknown>
  const pick =
    str(o.command) ||
    str(o.file_path) ||
    str(o.notebook_path) ||
    str(o.pattern) ||
    str(o.description) ||
    str(o.url) ||
    str(o.query) ||
    str(o.prompt) ||
    Object.values(o).find((v): v is string => typeof v === "string") ||
    ""
  const first = pick.split("\n")[0] ?? ""
  return first.length > 200 ? `${first.slice(0, 200)}…` : first || name
}

/** A tool result's text (string, or text blocks). */
function resultText(content: unknown): string {
  if (typeof content === "string") return content
  if (Array.isArray(content))
    return content
      .map((b) =>
        (b as { type?: string }).type === "text" ? str((b as { text?: unknown }).text) : "",
      )
      .filter(Boolean)
      .join("\n")
  return ""
}

export function claudeLine(o: Record<string, unknown>, log: ChatLog, lineNo: number): void {
  // Sub-agents, meta lines, and /compact's summary (written as a user line nobody typed).
  if (
    o.isSidechain === true ||
    o.isMeta === true ||
    o.isCompactSummary === true ||
    o.isVisibleInTranscriptOnly === true
  )
    return
  const type = o.type
  if (type !== "user" && type !== "assistant") return
  const msg = (o.message ?? {}) as { content?: unknown }
  const base = str(o.uuid) || `l${lineNo}`
  const content = msg.content
  if (type === "user" && typeof content === "string") {
    if (!NOT_TYPED.test(content) && content.trim())
      log.upsert({ id: base, kind: "user", text: clip(content, TEXT_MAX) })
    return
  }
  if (!Array.isArray(content)) return
  content.forEach((b: Record<string, unknown>, i) => {
    const id = `${base}:${i}`
    if (type === "user") {
      if (b.type === "text" && !NOT_TYPED.test(str(b.text)) && str(b.text).trim())
        log.upsert({ id, kind: "user", text: clip(str(b.text), TEXT_MAX) })
      else if (b.type === "tool_result") {
        const target = log.calls.get(str(b.tool_use_id))
        const item = target ? log.get(target) : undefined
        const text = resultText(b.content)
        if (item?.kind === "tool")
          log.upsert({ ...item, result: clip(text, RESULT_MAX), error: b.is_error === true })
        else if (item?.kind === "question") log.upsert({ ...item, answer: clip(text, RESULT_MAX) })
      }
      return
    }
    if (b.type === "text" && str(b.text).trim())
      log.upsert({ id, kind: "assistant", text: clip(str(b.text), TEXT_MAX) })
    else if (b.type === "tool_use") {
      const name = str(b.name)
      log.calls.set(str(b.id), id)
      const questions = name === "AskUserQuestion" ? questionsOf(b.input) : null
      if (questions) log.upsert({ id, kind: "question", questions })
      else log.upsert({ id, kind: "tool", name, summary: toolSummary(name, b.input) })
    }
  })
}

export const claudeChat = (files: string[]): ChatReader => new JsonlChat(files, claudeLine)
