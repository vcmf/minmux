// Answering an agent's dialog from a phone (docs/design/REMOTE_CONTROL.md, "Answering"): what the
// dialog on the pane's screen asks and offers, and the key that picks an option. Read from the
// screen itself (the remote-host worker's mirror of the pane), never assumed: an answer is only
// typed when the option it names is on screen right now. Agent specifics stay here.

import type { AgentKind } from "../../src/lib/agent-graph"

import { dialogSignature, type Dialog, type DialogOption } from "../../src/lib/remote-protocol"

export type { Dialog, DialogOption }

// "❯ 1. Yes", "  2. Yes, and don't ask again for …", "› 3. No, and tell Codex …"
const OPTION = /^\s*(?:[❯›>▶▸]\s*)?([1-9])\.\s+(.+?)\s*$/
// A box's top or bottom edge.
const EDGE = /^\s*[╭╰┌└─━]/
const MAX_GAP = 3 // wrapped / description lines kept with one option
const LABEL_MAX = 300 // a label's length kept (a wide pane, a wrapped label)
const BODY_MAX = 12 // body lines kept
// The box's side borders, when the dialog is drawn in one.
const BORDER = /^\s*[│|]\s?|\s?[│|]\s*$/g

/** The numbered dialog on the screen's last lines: its question, body and options, or null. */
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
  // Walk up over one block. Lines between options are an option's wrapped label (or description),
  // kept with it, so a phone sees all of what it approves; a blank line or the box's edge ends it.
  const options: DialogOption[] = []
  let i = end
  let carry: string[] = [] // lines under the option found next (going up)
  // Lines under the last option, down to the block's end.
  for (let k = end + 1; k < clean.length; k++) {
    const t = clean[k]!.trim()
    if (!t || EDGE.test(clean[k]!) || !/^\s{2,}/.test(clean[k]!)) break
    carry.push(t)
  }
  for (; i >= 0; i--) {
    const line = clean[i]!
    const m = OPTION.exec(line)
    if (m) {
      const label = [m[2]!, ...carry].join(" ").slice(0, LABEL_MAX)
      options.unshift({ n: Number(m[1]), label })
      carry = []
      if (m[1] === "1") break
    } else if (!line.trim() || EDGE.test(line) || carry.length >= MAX_GAP) break
    else carry.unshift(line.trim())
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
  // never approves something it wasn't shown. Without a box, up to a blank line.
  const body: string[] = []
  const inBox = boxed(clean, q)
  for (let k = q - 1; k >= 0 && body.length < BODY_MAX; k--) {
    if (EDGE.test(clean[k]!)) break
    const t = clean[k]!.trim()
    if (!t) {
      if (!inBox) break // no box: a blank line ends it
      continue
    }
    body.unshift(t.slice(0, LABEL_MAX))
  }
  return { kind: kindOf(question, options), question, body, options }
}

/** Inside a drawn box (an edge above the question within a few lines)? */
function boxed(clean: string[], q: number): boolean {
  for (let k = q - 1; k >= 0 && k >= q - BODY_MAX - 2; k--) if (EDGE.test(clean[k]!)) return true
  return false
}

// A permission prompt asks whether to go ahead and offers "Yes" first (Claude: "Do you want to
// proceed?", "Do you want to make this edit…?"); anything else is a question with choices.
const kindOf = (question: string, options: DialogOption[]): Dialog["kind"] =>
  /^(Do you want|Would you like) /i.test(question) && /^Yes\b/.test(options[0]?.label ?? "")
    ? "permission"
    : "question"

// Claude's permission prompts take the option's number (Claude Code's own strings). Its question
// dialogs don't end on a digit (a multi-select or multi-question ask only picks), and Codex's and
// OpenCode's keys aren't verified: those are answered in the Terminal view.
/** The keys that answer a permission prompt with option `n`, or null where we don't type. */
export { dialogSignature }

export function answerKeys(
  agent: AgentKind | undefined,
  kind: "permission" | "question",
  n: number,
): string | null {
  if (n < 1 || n > 9 || kind !== "permission") return null
  return agent === "claude" ? String(n) : null
}
