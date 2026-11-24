// A file tab rewrites a line whose HTML changed (its highlighted version landing after the plain
// one, or a re-read): the browser then drops a selection's ends there to the line's edges. The selection is
// kept as (row, character offset) and put back after the update, only on rows whose text didn't
// change (a re-read that moved lines would otherwise land it on other code).

/** One end of a selection: its row (`data-row`), the offset in that row's code, and that code. */
export interface RowPoint {
  row: string
  off: number
  text: string
}

/** A selection inside a file view, by row and offset (anchor and focus keep its direction). */
export interface SavedSelection {
  anchor: RowPoint
  focus: RowPoint
}

const CODE = ".file-view-code"

/** A DOM point as (row, offset in its code); a point on the gutter clamps to the code's edge. */
function pointOf(node: Node | null, offset: number): RowPoint | null {
  const el = node instanceof Element ? node : node?.parentElement
  const rowEl = el?.closest<HTMLElement>("[data-row]")
  const code = rowEl?.querySelector(CODE)
  if (!rowEl || !code || !node) return null
  const row = rowEl.dataset.row!
  const text = code.textContent ?? ""
  const r = document.createRange()
  r.selectNodeContents(code)
  // Before or after its code (on the gutter, or the row's edge): the code's start or end.
  if (r.comparePoint(node, offset) < 0) return { row, off: 0, text }
  if (r.comparePoint(node, offset) > 0) return { row, off: text.length, text }
  r.setEnd(node, offset)
  return { row, off: r.toString().length, text }
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

/** The text node + offset at a saved point (null: its row is gone or its text changed). */
function nodeAt(root: HTMLElement, p: RowPoint): [Node, number] | null {
  const code = root.querySelector(`[data-row="${CSS.escape(p.row)}"] ${CODE}`)
  if (!code || code.textContent !== p.text) return null
  const walk = document.createTreeWalker(code, NodeFilter.SHOW_TEXT)
  let left = p.off // within its text: the text is the one saved
  for (let t = walk.nextNode() as Text | null; t; t = walk.nextNode() as Text | null) {
    if (left <= t.length) return [t, left]
    left -= t.length
  }
  return [code, 0] // an empty line
}

/** Puts a saved selection back (skipped when one of its rows is gone or its text changed). */
export function restoreSelection(root: HTMLElement | null, saved: SavedSelection): void {
  if (!root) return
  const a = nodeAt(root, saved.anchor)
  const f = nodeAt(root, saved.focus)
  if (!a || !f) return
  window.getSelection()?.setBaseAndExtent(a[0], a[1], f[0], f[1])
}
