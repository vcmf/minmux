// Markdown rendering off the renderer's main thread (xterm draws there): a document's text in,
// its HTML out (lib/markdown). null when rendering failed: the tab shows its source then.
import { renderMarkdown } from "./markdown"

self.onmessage = async (e: MessageEvent<{ id: number; text: string }>) => {
  const { id, text } = e.data
  const out = await renderMarkdown(text).catch(() => null)
  ;(self as unknown as Worker).postMessage({ id, out })
}
