// Claude Code session colour → pane accent. Claude's `/color` and `/rename` are recorded in
// the session transcript (`agent-color` / `custom-title` lines); the main process folds them
// into a SessionMeta per pane (electron/transcript-meta). Pure so the rules are unit-tested.

/** A Claude session's metadata as read from its transcript. `color: null` = explicitly reset
 *  (`/color default`); `undefined` = never set. */
export interface SessionMeta {
  color?: string | null
  name?: string
}

/** The colours Claude Code's `/color` accepts (verified against the CLI docs + transcripts). */
export const ACCENT_COLORS = [
  "red",
  "blue",
  "green",
  "yellow",
  "purple",
  "orange",
  "pink",
  "cyan",
] as const
export type AccentColor = (typeof ACCENT_COLORS)[number]

// Per-scheme swatches: saturated enough to read as an accent on the pane header, and
// darker in light themes so a 2px border still stands out against a pale background.
const SWATCHES: Record<"dark" | "light", Record<AccentColor, string>> = {
  dark: {
    red: "#f0625f",
    blue: "#5b9cf5",
    green: "#4ec97a",
    yellow: "#e8c547",
    purple: "#b180f0",
    orange: "#f0913d",
    pink: "#f07ab8",
    cyan: "#4cc9d8",
  },
  light: {
    red: "#d33a47",
    blue: "#2f6fdb",
    green: "#1f9d55",
    yellow: "#b58a00",
    purple: "#8a4fd6",
    orange: "#d9661a",
    pink: "#d4468f",
    cyan: "#138a9a",
  },
}

const isAccentColor = (c: string): c is AccentColor =>
  (ACCENT_COLORS as readonly string[]).includes(c)

/** FNV-1a — a stable, well-spread 32-bit hash so a name always maps to the same colour. */
function hash(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/** Which Claude colour a session shows: an explicit `/color` wins; else a renamed session gets
 *  a stable colour derived from its name (cmux-style); a reset or unnamed session has none. */
export function sessionColorName(meta: SessionMeta | undefined): AccentColor | undefined {
  if (!meta) return undefined
  if (typeof meta.color === "string") return isAccentColor(meta.color) ? meta.color : undefined
  if (meta.color === null) return undefined // `/color default` — the user asked for none
  const name = meta.name?.trim()
  return name ? ACCENT_COLORS[hash(name) % ACCENT_COLORS.length] : undefined
}

/** The session's accent as a CSS colour for the current scheme (undefined = no accent). */
export function sessionColor(
  meta: SessionMeta | undefined,
  scheme: "dark" | "light",
): string | undefined {
  const name = sessionColorName(meta)
  return name ? SWATCHES[scheme][name] : undefined
}
