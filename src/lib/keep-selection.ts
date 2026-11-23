// A file tab replaces a line's HTML when its highlighted version lands (plain first) or the file
// is re-read: the browser then drops the selection's ends to the line's edges. The text is the
// same, so the selection is kept as (row, character offset) and put back after the update.

/** One end of a selection: its row (`data-row`) and the offset in that row's code text. */
export interface RowPoint {
  row: string
  off: number
}

/** A selection inside a file view, by row and offset (anchor and focus keep its direction). */
export interface SavedSelection {
  anchor: RowPoint
  focus: RowPoint
}

const CODE = ".file-view-code"

function pointOf(node: Node | null, offset: number): RowPoint | null {
  const el = node instanceof Element ? node : node?.parentElement
  const rowEl = el?.closest<HTMLElement>("[data-row]")
  const code = rowEl?.querySelector(CODE)
  if (!rowEl || !code || !node) return null
  const row = rowEl.dataset.row!
  const r = document.createRange()
  r.selectNodeContents(code)
  // Before or after its code (on the gutter, or the row's edge): the code's start or end.
  if (r.comparePoint(node, offset) < 0) return { row, off: 0 }
  if (r.comparePoint(node, offset) > 0) return { row, off: code.textContent?.length ?? 0 }
  r.setEnd(node, offset)
  return { row, off: r.toString().length }
}

/** The selection, when both its ends are on rows inside `root` (else null: nothing to keep). */
export function saveSelection(root: HTMLElement | null): SavedSelection | null {
  const sel = root && window.getSelection()
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null
  if (!root.contains(sel.anchorNode) || !root.contains(sel.focusNode)) return null
  const anchor = pointOf(sel.anchorNode, sel.anchorOffset)
  const focus = pointOf(sel.focusNode, sel.focusOffset)
  return anchor && focus ? { anchor, focus } : null
}

function nodeAt(root: HTMLElement, p: RowPoint): [Node, number] | null {
  const code = root.querySelector(`[data-row="${CSS.escape(p.row)}"] ${CODE}`)
  if (!code) return null
  const walk = document.createTreeWalker(code, NodeFilter.SHOW_TEXT)
  let left = p.off
  let last: Text | null = null
  for (let t = walk.nextNode() as Text | null; t; t = walk.nextNode() as Text | null) {
    if (left <= t.length) return [t, left]
    left -= t.length
    last = t
  }
  return last ? [last, last.length] : [code, code.childNodes.length] // shorter now: its end
}

/** Puts a saved selection back (skipped when one of its rows isn't rendered any more). */
export function restoreSelection(root: HTMLElement | null, saved: SavedSelection): void {
  if (!root) return
  const a = nodeAt(root, saved.anchor)
  const f = nodeAt(root, saved.focus)
  if (!a || !f) return
  window.getSelection()?.setBaseAndExtent(a[0], a[1], f[0], f[1])
}
