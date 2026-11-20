// The highlighter, off the renderer's main thread (xterm draws there): a file tab's text in, its
// highlighted HTML out. Same lazy highlight.js and language set as the preview (lib/highlighter).
import { highlightToHtml } from "./highlighter"

self.onmessage = async (e: MessageEvent<{ id: number; code: string; lang: string | null }>) => {
  const { id, code, lang } = e.data
  ;(self as unknown as Worker).postMessage({ id, html: await highlightToHtml(code, lang) })
}
