// Agents' multiple-choice asks → the chat view's neutral ChatQuestion.
import type { ChatQuestion } from "../../src/lib/remote-chat"

/** A multiple-choice ask's questions, from the shape Claude, Codex and OpenCode share (each names
 *  multi-select its own way: multiSelect, multi_select, multiple). */
export function questionsOf(input: unknown): ChatQuestion[] | null {
  const qs = (input as { questions?: unknown } | null)?.questions
  if (!Array.isArray(qs) || qs.length === 0) return null
  const out: ChatQuestion[] = []
  for (const q of qs) {
    const o = q as Record<string, unknown>
    if (typeof o?.question !== "string") continue
    const options = Array.isArray(o.options)
      ? o.options.flatMap((x) => {
          const p = x as Record<string, unknown>
          if (typeof p?.label !== "string") return []
          return [
            typeof p.description === "string"
              ? { label: p.label, description: p.description }
              : { label: p.label },
          ]
        })
      : []
    out.push({
      ...(typeof o.header === "string" ? { header: o.header } : {}),
      question: o.question,
      multi: o.multiSelect === true || o.multiple === true || o.multi_select === true,
      options,
    })
  }
  return out.length ? out : null
}
