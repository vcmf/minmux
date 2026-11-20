// Which rows of a long fixed-height list to render: the ones in view plus a margin. Short lists
// render whole (VIRTUAL_FROM), so a small tree stays plain DOM.

export const VIRTUAL_FROM = 300
export const OVERSCAN = 20 // rows rendered above and below the viewport

// `count` rows of `rowH` px, scrolled to `top` in a viewport `viewH` px tall.
/** The rows to render, [start, end); everything when the list is short. */
export function rowWindow(
  count: number,
  rowH: number,
  top: number,
  viewH: number,
  from = VIRTUAL_FROM,
  overscan = OVERSCAN,
): { start: number; end: number } {
  if (count <= from || rowH <= 0) return { start: 0, end: count }
  const start = Math.max(0, Math.floor(top / rowH) - overscan)
  const end = Math.min(count, Math.ceil((top + Math.max(viewH, rowH)) / rowH) + overscan)
  return { start, end: Math.max(start, end) }
}
