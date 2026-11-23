// A rendered markdown view's place: each top-level block carries the source line it starts on
// (`data-line`, lib/markdown), so a re-render or a switch to Source keeps the text in view.

/** The top-level block holding source line `line` (the last one starting at or before it). */
export function blockAt(body: HTMLElement, line: number): HTMLElement | null {
  let best: HTMLElement | null = null
  for (const el of body.querySelectorAll<HTMLElement>(":scope > [data-line]")) {
    if (Number(el.dataset.line) > line) break
    best = el
  }
  return best ?? body.querySelector<HTMLElement>(":scope > [data-line]")
}

/** A place in the view: a block (its source line and text) and how far into it the view starts. */
export interface Place {
  line: number
  off: number
  text: string
}

/** The first block in view. */
// A block without a line (raw HTML, display math) at the top counts as the lined one above it.
export function topBlock(scroller: HTMLElement, body: HTMLElement): Place {
  const top = scroller.scrollTop
  let last: HTMLElement | null = null
  for (const el of body.querySelectorAll<HTMLElement>(":scope > [data-line]")) {
    if (el.offsetTop > top) break
    last = el
    if (el.offsetTop + el.offsetHeight > top) break
  }
  if (!last) return { line: 1, off: 0, text: "" }
  return {
    line: Number(last.dataset.line),
    off: top - last.offsetTop,
    text: last.textContent ?? "",
  }
}

// Lines move when text is added above (an agent inserting a section), so the block is found by
// its text first: the match nearest its old line. A block that changed falls back to the line.
/** The block a place was on, after a re-render. */
export function blockOf(body: HTMLElement, at: Place): HTMLElement | null {
  let best: HTMLElement | null = null
  let gap = Infinity
  if (at.text) {
    for (const el of body.querySelectorAll<HTMLElement>(":scope > [data-line]")) {
      if (el.textContent !== at.text) continue
      const d = Math.abs(Number(el.dataset.line) - at.line)
      if (d < gap) [best, gap] = [el, d]
    }
  }
  return best ?? blockAt(body, at.line)
}
