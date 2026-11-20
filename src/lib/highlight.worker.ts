// The highlighter, off the renderer's main thread (xterm draws there): a file tab's text in, its
// lines out, highlighted and split here too (lib/split-highlighted), or escaped and split when
// there's no language or it's too big to highlight. The main thread only renders them.
import { highlightToHtml } from "./highlighter"
import { splitHighlighted } from "./split-highlighted"
import { escapeHtml, HIGHLIGHT_MAX } from "./file-preview"

self.onmessage = async (e: MessageEvent<{ id: number; code: string; lang: string | null }>) => {
  const { id, code, lang } = e.data
  const lines =
    !lang || code.length > HIGHLIGHT_MAX
      ? escapeHtml(code).split("\n")
      : splitHighlighted(await highlightToHtml(code, lang))
  ;(self as unknown as Worker).postMessage({ id, lines })
}
