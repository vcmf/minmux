// Answering an agent's dialog from a phone (docs/design/REMOTE_CONTROL.md, "Answering"): what the
// dialog on the pane's screen asks and offers, and the key that picks an option. Read from the
// screen itself (the remote-host worker's mirror of the pane), never assumed: an answer is only
// typed when the option it names is on screen right now. Agent specifics stay here.

import type { AgentKind } from "../../src/lib/agent-graph"

import type { Dialog, DialogOption } from "../../src/lib/remote-protocol"

export type { Dialog, DialogOption }

// "❯ 1. Yes", "  2. Yes, and don't ask again for …", "› 3. No, and tell Codex …"
const OPTION = /^\s*(?:[❯›>▶▸]\s*)?([1-9])\.\s+(.+?)\s*$/
// The box's side borders, when the dialog is drawn in one.
const BORDER = /^\s*[│|]\s?|\s?[│|]\s*$/g

/** The numbered dialog on the screen's last lines: its question and options, or null. */
export function parseDialog(lines: string[]): Dialog | null {
  const clean = lines.map((l) => l.replace(BORDER, "").trimEnd())
  // The options block nearest the bottom: consecutive numbers 1, 2, 3…
  let end = -1
  for (let i = clean.length - 1; i >= 0; i--)
    if (OPTION.test(clean[i]!)) {
      end = i
      break
    }
  if (end < 0) return null
  const options: DialogOption[] = []
  let i = end
  // Walk up over the block (descriptions between options are allowed).
  for (; i >= 0 && i >= end - 40; i--) {
    const m = OPTION.exec(clean[i]!)
    if (m) options.unshift({ n: Number(m[1]), label: m[2]! })
    else if (options.length && options[0]!.n === 1) break
  }
  if (!options.length || options[0]!.n !== 1) return null
  if (options.some((o, k) => o.n !== k + 1)) return null
  // The question: the nearest line above the options that asks something.
  let question = ""
  for (let k = i; k >= 0 && k >= i - 15; k--) {
    const t = clean[k]!.trim()
    if (t.endsWith("?")) {
      question = t
      break
    }
  }
  if (!question) return null
  return { question, options }
}

/** The keys that pick option `n`, for an agent whose dialogs take its number (Claude). Others:
 *  null (the phone points to the Terminal view and its keys bar). */
export function answerKeys(agent: AgentKind | undefined, n: number): string | null {
  if (n < 1 || n > 9) return null
  return (agent ?? "claude") === "claude" ? String(n) : null
}
