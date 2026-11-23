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
export function topBlock(scroller: HTMLElement, body: HTMLElement): { line: number; off: number } {
  const top = scroller.scrollTop
  for (const el of body.querySelectorAll<HTMLElement>(":scope > [data-line]")) {
    if (el.offsetTop + el.offsetHeight > top) {
      return { line: Number(el.dataset.line), off: top - el.offsetTop }
    }
  }
  return { line: 1, off: 0 }
}
