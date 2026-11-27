// An agent conversation as the phone's chat view shows it (docs/design/REMOTE_CONTROL.md, "Chat
// view"): items read from the agent's transcript in the remote-host worker. Shared by the worker's
// readers (electron/agents/*-chat.ts) and the web app.

export interface ChatOption {
  label: string
  description?: string
}

/** One question of a multiple-choice ask (Claude's AskUserQuestion, Codex's request_user_input). */
export interface ChatQuestion {
  header?: string
  question: string
  multi: boolean // several options may be picked
  options: ChatOption[]
}

export type ChatItem =
  | { id: string; kind: "user"; text: string }
  | { id: string; kind: "assistant"; text: string }
  | { id: string; kind: "tool"; name: string; summary: string; result?: string; error?: boolean }
  | { id: string; kind: "question"; questions: ChatQuestion[]; answer?: string }

export const TEXT_MAX = 8000
export const RESULT_MAX = 2000

/** Text cut to `max` characters (with a marker), for the wire. */
export const clip = (s: string, max: number): string =>
  s.length > max ? `${s.slice(0, max)}\n… (${s.length - max} more characters)` : s

/** A multiple-choice ask's questions, from the shape Claude, Codex and OpenCode share. */
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
