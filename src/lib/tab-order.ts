// Reordering sessions (tabs) by drag & drop — the top bar and the sidebar show the same list,
// so both drop through here. Pure: the index math is what goes wrong, so it's tested.

/** Move `id` so it lands before the item now at `insertAt` (0…length); same array if no-op. */
export function moveTo<T extends { id: string }>(items: T[], id: string, insertAt: number): T[] {
  const from = items.findIndex((t) => t.id === id)
  if (from < 0) return items
  const at = Math.max(0, Math.min(insertAt, items.length))
  // Dropping on either side of itself changes nothing.
  if (at === from || at === from + 1) return items
  const next = items.slice()
  const [moved] = next.splice(from, 1)
  next.splice(at > from ? at - 1 : at, 0, moved!)
  return next
}

/** Where a drop at `pos` (clientX / clientY) goes, given each item's [start, end] along the
 *  axis: before the first item whose midpoint is past the pointer, else at the end. */
export function insertIndexAt(spans: [number, number][], pos: number): number {
  for (let i = 0; i < spans.length; i++) {
    const [a, b] = spans[i]!
    if (pos < (a + b) / 2) return i
  }
  return spans.length
}

/** The drag payload type for a session (tab) — distinct from a terminal (surface) drag. */
export const TAB_DRAG_TYPE = "application/x-smterm-tab"
