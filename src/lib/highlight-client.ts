// A file tab's highlighted lines: highlight.js in a Web Worker (lib/highlight.worker), split into
// lines (lib/split-highlighted). Where there's no Worker (tests), on this thread instead. Past
// HIGHLIGHT_MAX it's plain escaped text: highlighting would take too long either way.
import { escapeHtml, HIGHLIGHT_MAX } from "./file-preview"
import { highlightToHtml } from "./highlighter"
import { splitHighlighted } from "./split-highlighted"

let worker: Worker | null = null
let broken = false // the worker failed to load or crashed: this thread highlights from now on
let seq = 0
const waiting = new Map<number, (html: string | null) => void>() // null: the worker failed

/** Every request still waiting gets null (it's highlighted here instead). */
function fail(): void {
  broken = true
  worker?.terminate()
  worker = null
  waiting.forEach((done) => done(null))
  waiting.clear()
}

function getWorker(): Worker | null {
  if (worker || broken || typeof Worker === "undefined") return worker
  try {
    worker = new Worker(new URL("./highlight.worker.ts", import.meta.url), { type: "module" })
    worker.onmessage = (e: MessageEvent<{ id: number; html: string }>) => {
      waiting.get(e.data.id)?.(e.data.html)
      waiting.delete(e.data.id)
    }
    worker.onerror = fail
    worker.onmessageerror = fail
  } catch {
    fail()
  }
  return worker
}

/** The text's lines as plain, escaped HTML (shown until the highlighted ones arrive). */
export const plainLines = (code: string): string[] => escapeHtml(code).split("\n")

/** The text's lines, highlighted as `lang` (plain when unknown or too big). */
export async function highlightLines(code: string, lang: string | null): Promise<string[]> {
  if (!lang || code.length > HIGHLIGHT_MAX) return plainLines(code)
  const w = getWorker()
  const fromWorker = w
    ? await new Promise<string | null>((resolve) => {
        const id = ++seq
        waiting.set(id, resolve)
        w.postMessage({ id, code, lang })
      })
    : null
  return splitHighlighted(fromWorker ?? (await highlightToHtml(code, lang)))
}
