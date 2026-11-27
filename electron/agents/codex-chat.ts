// Codex's rollout as chat items (the phone's chat view). Best-effort over an internal format:
// unknown records are skipped; text Codex injects into the user's turn is left out.

import { isTypedPrompt } from "../../src/lib/past-sessions"
import { clip, RESULT_MAX, TEXT_MAX } from "../../src/lib/remote-chat"
import { questionsOf } from "./questions"
import { JsonlChat, type ChatLog, type ChatReader } from "./chat-log"
import { toolSummary } from "./claude-chat"
import { INJECTED, typedText } from "./codex-history"

const str = (v: unknown): string => (typeof v === "string" ? v : "")

const texts = (content: unknown, kind: string): string[] =>
  Array.isArray(content)
    ? content.flatMap((b) => {
        const o = b as { type?: string; text?: unknown }
        return o.type === kind && typeof o.text === "string" ? [o.text] : []
      })
    : []

/** A tool output: a string, or input_text blocks. */
const outputText = (v: unknown): string =>
  typeof v === "string" ? v : texts(v, "input_text").join("\n")

function parseArgs(raw: unknown): unknown {
  if (typeof raw !== "string") return raw
  try {
    return JSON.parse(raw)
  } catch {
    return { command: raw }
  }
}

/** Codex's code-mode calls: the shell command inside `tools.exec_command({cmd:"…"})`. */
function customSummary(name: string, input: string): string {
  const cmd = /\bcmd\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(input)?.[1]
  return toolSummary(name, { command: cmd ? cmd.replace(/\\"/g, '"') : input })
}

export function codexLine(o: Record<string, unknown>, log: ChatLog, lineNo: number): void {
  if (o.type !== "response_item") return
  const p = (o.payload ?? {}) as Record<string, unknown>
  const id = str(p.id) || `l${lineNo}`
  switch (p.type) {
    case "message": {
      if (p.role === "user") {
        const said = texts(p.content, "input_text")
          .map((t) => typedText(t))
          .filter((t): t is string => t !== undefined && isTypedPrompt(t, INJECTED))
          .join("\n")
        if (said.trim()) log.upsert({ id, kind: "user", text: clip(said, TEXT_MAX) })
      } else if (p.role === "assistant") {
        const said = texts(p.content, "output_text").join("\n")
        if (said.trim()) log.upsert({ id, kind: "assistant", text: clip(said, TEXT_MAX) })
      }
      return
    }
    case "function_call":
    case "custom_tool_call": {
      const name = str(p.name)
      log.calls.set(str(p.call_id), id)
      const args = p.type === "function_call" ? parseArgs(p.arguments) : p.input
      const questions = name === "request_user_input" ? questionsOf(args) : null
      if (questions) return log.upsert({ id, kind: "question", questions })
      const summary =
        p.type === "custom_tool_call" ? customSummary(name, str(p.input)) : toolSummary(name, args)
      return log.upsert({ id, kind: "tool", name, summary })
    }
    case "function_call_output":
    case "custom_tool_call_output": {
      const target = log.calls.get(str(p.call_id))
      const item = target ? log.get(target) : undefined
      const text = outputText(p.output)
      if (item?.kind === "tool") log.upsert({ ...item, result: clip(text, RESULT_MAX) })
      else if (item?.kind === "question") log.upsert({ ...item, answer: clip(text, RESULT_MAX) })
      return
    }
  }
}

export const codexChat = (files: string[]): ChatReader => new JsonlChat(files, codexLine)
