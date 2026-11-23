// A markdown file tab's Preview: rendered in a Web Worker (lib/markdown.worker); where there's no
// Worker (tests) or it broke, on this thread, the renderer then loading as its own chunk. The last
// few results are kept by text, so a tab shown again gets its HTML at once.
import type { Rendered } from "./markdown"

export const MARKDOWN_MAX = 1024 * 1024 // past this a file tab shows its source (DOM cost)
const KEPT = 8

let worker: Worker | null = null
let broken = false
let seq = 0
const waiting = new Map<number, (out: Rendered | null | undefined) => void>() // undefined: failed
const kept = new Map<string, Rendered>() // insertion order = least → most recent

function fail(): void {
  broken = true
  worker?.terminate()
  worker = null
  waiting.forEach((done) => done(undefined))
  waiting.clear()
}

function getWorker(): Worker | null {
  if (worker || broken || typeof Worker === "undefined") return worker
  try {
    worker = new Worker(new URL("./markdown.worker.ts", import.meta.url), { type: "module" })
    worker.onmessage = (e: MessageEvent<{ id: number; out: Rendered | null }>) => {
      waiting.get(e.data.id)?.(e.data.out)
      waiting.delete(e.data.id)
    }
    worker.onerror = fail
    worker.onmessageerror = fail
  } catch {
    fail()
  }
  return worker
}

/** `text`'s rendering from the last few, if it's there. */
export function renderedNow(text: string): Rendered | undefined {
  return kept.get(text)
}

function keep(text: string, r: Rendered): void {
  kept.delete(text)
  kept.set(text, r)
  if (kept.size > KEPT) kept.delete(kept.keys().next().value!)
}

/** `text` rendered as markdown; null when it couldn't be. */
export async function renderMarkdownText(text: string): Promise<Rendered | null> {
  const now = kept.get(text)
  if (now) return now
  const w = getWorker()
  let out: Rendered | null | undefined = undefined
  if (w) {
    out = await new Promise<Rendered | null | undefined>((resolve) => {
      const id = ++seq
      waiting.set(id, resolve)
      w.postMessage({ id, text })
    })
  }
  if (out === undefined) {
    out = await import("./markdown").then((m) => m.renderMarkdown(text)).catch(() => null)
  }
  if (out) keep(text, out)
  if (out?.math) void loadMathStyle()
  return out
}

let mathStyle: Promise<unknown> | null = null
/** KaTeX's stylesheet and fonts, added to the page once (the first document with math). */
export function loadMathStyle(): Promise<unknown> {
  mathStyle ??= import("katex/dist/katex.min.css").catch(() => (mathStyle = null))
  return mathStyle
}
