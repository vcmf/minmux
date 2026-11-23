// A markdown file tab's Preview: rendered in a Web Worker (lib/markdown.worker); where there's no
// Worker (tests), on this thread, the renderer then loading as its own chunk. The last few results
// are kept by text, so a tab shown again gets its HTML at once.
import type { Rendered } from "./markdown"

export const MARKDOWN_MAX = 1024 * 1024 // past this a file tab shows its source (DOM cost)
const KEPT = 64 // a PR's body and comments each take one…
const KEPT_CHARS = 4 * 1024 * 1024 // …and big documents only a few

let worker: Worker | null = null
let failures = 0 // the worker crashed or failed to load: respawned up to MAX_FAILURES times
const MAX_FAILURES = 3
const RENDER_TIMEOUT_MS = 10_000 // a render stuck this long: the worker is replaced
let seq = 0
const waiting = new Map<number, (out: Rendered | null | undefined) => void>() // undefined: failed
const kept = new Map<string, Rendered>() // insertion order = least → most recent

function fail(): void {
  failures++
  worker?.terminate()
  worker = null
  waiting.forEach((done) => done(undefined))
  waiting.clear()
}

function getWorker(): Worker | null {
  if (worker || failures >= MAX_FAILURES || typeof Worker === "undefined") return worker
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

const keyOf = (text: string, repo?: string) => (repo ? `${repo}\0${text}` : text)

/** `text`'s rendering from the last few, if it's there. */
export function renderedNow(text: string, repo?: string): Rendered | undefined {
  return kept.get(keyOf(text, repo))
}

let keptChars = 0
function keep(key: string, r: Rendered): void {
  const old = kept.get(key)
  if (old) keptChars -= old.html.length
  kept.delete(key)
  kept.set(key, r)
  keptChars += r.html.length
  while (kept.size > 1 && (kept.size > KEPT || keptChars > KEPT_CHARS)) {
    const [k, v] = kept.entries().next().value!
    kept.delete(k)
    keptChars -= v.html.length
  }
}

/** `text` rendered as markdown (as a comment in `repo`, when given); null when it couldn't be. */
export async function renderMarkdownText(text: string, repo?: string): Promise<Rendered | null> {
  const key = keyOf(text, repo)
  const now = kept.get(key)
  if (now) return now
  // Never on this thread where there are workers (xterm draws here): a broken worker shows the
  // source instead. Only tests (no Worker) render here.
  let out: Rendered | null | undefined
  if (typeof Worker === "undefined") {
    out = await import("./markdown").then((m) => m.renderMarkdown(text, { repo })).catch(() => null)
  } else {
    const w = getWorker()
    out = w
      ? await new Promise<Rendered | null | undefined>((resolve) => {
          const id = ++seq
          const timer = setTimeout(fail, RENDER_TIMEOUT_MS) // every waiting one: the source
          waiting.set(id, (out) => {
            clearTimeout(timer)
            resolve(out)
          })
          w.postMessage({ id, text, repo })
        })
      : null
  }
  out ??= null
  if (out) keep(key, out)
  return out
}

let mathStyle: Promise<unknown> | null = null
let mathStyled = false
/** KaTeX's stylesheet and fonts, added to the page once (the first document with math). */
export function loadMathStyle(): Promise<unknown> {
  mathStyle ??= import("katex/dist/katex.min.css").then(
    () => (mathStyled = true),
    () => (mathStyle = null),
  )
  return mathStyle
}

/** Whether KaTeX's stylesheet is in. */
export const mathStyleReady = () => mathStyled
