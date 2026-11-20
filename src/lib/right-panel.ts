// Pure sizing for the resizable right panel (the agents list).
// The drag handle + persistence live elsewhere; the clamp is here so it's unit-tested.

export const RIGHT_PANEL_MIN = 280 // keep the agents list readable
export const RIGHT_PANEL_MAX = 760 // absolute cap regardless of window size
export const RIGHT_PANEL_DEFAULT = 388

/** Clamp a desired width to [MIN, min(MAX, maxAvail)]. `maxAvail` (e.g. 60% of the
 *  window) keeps the panel from swallowing the terminals; omit it for a fixed clamp
 *  (workspace restore, where the window size isn't known yet). */
export function clampPanelWidth(px: number, maxAvail = RIGHT_PANEL_MAX): number {
  const max = Math.min(RIGHT_PANEL_MAX, maxAvail)
  if (!Number.isFinite(px)) return Math.min(RIGHT_PANEL_DEFAULT, max)
  return Math.max(RIGHT_PANEL_MIN, Math.min(max, Math.round(px)))
}
