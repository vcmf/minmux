// A rendered markdown view's place, by source line: each top-level block carries the line it
// starts on (`data-line`, lib/markdown), so a re-render or a switch to Source keeps the text in view.

/** The top-level block holding source line `line` (the last one starting at or before it). */
export function blockAt(body: HTMLElement, line: number): HTMLElement | null {
  let best: HTMLElement | null = null
  for (const el of body.querySelectorAll<HTMLElement>(":scope > [data-line]")) {
    if (Number(el.dataset.line) > line) break
    best = el
  }
  return best ?? body.querySelector<HTMLElement>(":scope > [data-line]")
}

/** The first block in view: its source line and how far into it the view starts. */
// A block without a line (raw HTML, display math) at the top counts as the lined one above it.
export function topBlock(scroller: HTMLElement, body: HTMLElement): { line: number; off: number } {
  const top = scroller.scrollTop
  let last: HTMLElement | null = null
  for (const el of body.querySelectorAll<HTMLElement>(":scope > [data-line]")) {
    if (el.offsetTop > top) break
    last = el
    if (el.offsetTop + el.offsetHeight > top) break
  }
  return last ? { line: Number(last.dataset.line), off: top - last.offsetTop } : { line: 1, off: 0 }
}
