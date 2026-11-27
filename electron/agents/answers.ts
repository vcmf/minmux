// Answering an agent's dialog from a phone (docs/design/REMOTE_CONTROL.md, "Answering"): what the
// dialog on the pane's screen asks and offers, and the key that picks an option. Read from the
// screen itself (the remote-host worker's mirror of the pane), never assumed: an answer is only
// typed when the option it names is on screen right now. Agent specifics stay here.

import type { AgentKind } from "../../src/lib/agent-graph"

import type { Dialog, DialogOption } from "../../src/lib/remote-protocol"

export type { Dialog, DialogOption }

// "❯ 1. Yes", "  2. Yes, and don't ask again for …", "› 3. No, and tell Codex …"
const OPTION = /^\s*(?:[❯›>▶▸]\s*)?([1-9])\.\s+(.+?)\s*$/
// A box's top or bottom edge.
const EDGE = /^\s*[╭╰┌└─━]/
const MAX_GAP = 3 // description lines allowed between two options
const LABEL_MAX = 200 // a line's length kept (a wide pane's long label)
const BODY_MAX = 12 // body lines kept
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
  let gap = 0
  // Walk up over one block: an option's description lines may sit between options (a few), but a
  // blank line or the box's edge ends it (a numbered list higher up is something else).
  for (; i >= 0; i--) {
    const line = clean[i]!
    const m = OPTION.exec(line)
    if (m) {
      options.unshift({ n: Number(m[1]), label: m[2]!.slice(0, LABEL_MAX) })
      gap = 0
      if (m[1] === "1") break
    } else if (!line.trim() || EDGE.test(line) || ++gap > MAX_GAP) break
  }
  if (!options.length || options[0]!.n !== 1) return null
  if (options.some((o, k) => o.n !== k + 1)) return null
  // The question: the nearest line above the options that asks something, inside the box.
  let question = ""
  let q = i
  for (let k = i; k >= 0 && k >= i - 15; k--) {
    const t = clean[k]!.trim()
    if (EDGE.test(clean[k]!)) break
    if (t.endsWith("?")) {
      question = t.slice(0, LABEL_MAX)
      q = k
      break
    }
  }
  if (!question) return null
  // What it asks about: the box's lines above the question (the command, the file), so a phone
  // never approves something it wasn't shown.
  const body: string[] = []
  for (let k = q - 1; k >= 0 && body.length < BODY_MAX; k--) {
    if (EDGE.test(clean[k]!)) break
    const t = clean[k]!.trim()
    if (t) body.unshift(t.slice(0, LABEL_MAX))
  }
  return { question, body, options }
}

/** What a device saw of a dialog, compared with the screen again before typing its answer. */
export const dialogSignature = (d: Dialog): string =>
  JSON.stringify([d.question, d.body, d.options.map((o) => [o.n, o.label])])

// Claude's permission prompts take the option's number (Claude Code's own strings). Its question
// dialogs don't end on a digit (a multi-select or multi-question ask only picks), and Codex's and
// OpenCode's keys aren't verified: those are answered in the Terminal view.
/** The keys that answer a permission prompt with option `n`, or null where we don't type. */
export function answerKeys(
  agent: AgentKind | undefined,
  kind: "permission" | "question",
  n: number,
): string | null {
  if (n < 1 || n > 9 || kind !== "permission") return null
  return agent === "claude" ? String(n) : null
}
