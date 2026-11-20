// A file tab's highlighted lines: highlight.js in a Web Worker (lib/highlight.worker), split into
// lines (lib/split-highlighted). Where there's no Worker (tests), on this thread instead. Past
// HIGHLIGHT_MAX it's plain escaped text: highlighting would take too long either way.
import { escapeHtml, HIGHLIGHT_MAX } from "./file-preview"
import { highlightToHtml } from "./highlighter"
import { splitHighlighted } from "./split-highlighted"

let worker: Worker | null = null
let seq = 0
const waiting = new Map<number, (html: string) => void>()

function getWorker(): Worker | null {
  if (worker || typeof Worker === "undefined") return worker
  try {
    worker = new Worker(new URL("./highlight.worker.ts", import.meta.url), { type: "module" })
    worker.onmessage = (e: MessageEvent<{ id: number; html: string }>) => {
      waiting.get(e.data.id)?.(e.data.html)
      waiting.delete(e.data.id)
    }
  } catch {
    worker = null
  }
  return worker
}

/** The text's lines as plain, escaped HTML (shown until the highlighted ones arrive). */
export const plainLines = (code: string): string[] => escapeHtml(code).split("\n")

/** The text's lines, highlighted as `lang` (plain when unknown or too big). */
export async function highlightLines(code: string, lang: string | null): Promise<string[]> {
  if (!lang || code.length > HIGHLIGHT_MAX) return plainLines(code)
  const w = getWorker()
  const html = w
    ? await new Promise<string>((resolve) => {
        const id = ++seq
        waiting.set(id, resolve)
        w.postMessage({ id, code, lang })
      })
    : await highlightToHtml(code, lang)
  return splitHighlighted(html)
}
