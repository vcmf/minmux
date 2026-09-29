import type { ITheme } from "@xterm/xterm"

/** UI tokens become CSS custom properties; `terminal` is xterm's theme object.
 *  Token set follows the `mux` design spec (see docs/mux_product_spec.md). */
export interface Theme {
  name: string
  label: string // full name, e.g. "Catppuccin Latte"
  variant: string // short name within its family, e.g. "Latte" (theme cards)
  scheme: "dark" | "light" // drives CSS `color-scheme` (native controls, scrollbars)
  ui: {
    bg: string // window base
    panel: string // bars, sidebar, panes
    elev: string // hover/active surfaces, cards
    border: string // hairline dividers
    border2: string // stronger borders (active tab, keycaps)
    text: string // primary text
    dim: string // secondary text
    faint: string // tertiary text / disabled
    accent: string // running / brand (green)
    amber: string // waiting / approval
    red: string // error / removed
    blue: string // human / info
    scrim: string // modal backdrop
    shadow: string // drop-shadow colour (popovers, dialogs)
  }
  terminal: ITheme
}

/** A theme family: one look in a dark and a light variant (switched by `appearance`). */
export interface ThemeFamily {
  name: string
  label: string
  dark: Theme
  light: Theme
}

export type Appearance = "dark" | "light" | "system"

// Shared per-scheme tokens (scrim + shadow read the same across families).
const DARK = { scrim: "rgba(4,4,6,0.55)", shadow: "rgba(0,0,0,0.75)" }
const LIGHT = { scrim: "rgba(20,22,30,0.28)", shadow: "rgba(20,24,40,0.22)" }
const DARK_BORDERS = { border: "rgba(255,255,255,0.07)", border2: "rgba(255,255,255,0.12)" }
const LIGHT_BORDERS = { border: "rgba(0,0,0,0.08)", border2: "rgba(0,0,0,0.14)" }

// ── Minimal ──────────────────────────────────────────────
const minimalDark: Theme = {
  name: "minimal-dark",
  label: "Minimal Dark",
  variant: "Dark",
  scheme: "dark",
  ui: {
    bg: "#0b0b0d",
    panel: "#0f0f12",
    elev: "#17171b",
    ...DARK_BORDERS,
    text: "#e8e8ea",
    dim: "#9a9aa2",
    faint: "#5c5c64",
    accent: "#4ec97a",
    amber: "#e0a94a",
    red: "#f0625f",
    blue: "#6aa0f0",
    ...DARK,
  },
  terminal: {
    background: "#0b0b0d",
    foreground: "#e8e8ea",
    cursor: "#4ec97a",
    selectionBackground: "rgba(120,200,150,0.25)",
    black: "#2a2a2e",
    red: "#f0625f",
    green: "#4ec97a",
    yellow: "#e0a94a",
    blue: "#6aa0f0",
    magenta: "#c678dd",
    cyan: "#56b6c2",
    white: "#e8e8ea",
    brightBlack: "#5c5c64",
    brightRed: "#f0625f",
    brightGreen: "#4ec97a",
    brightYellow: "#e0a94a",
    brightBlue: "#6aa0f0",
    brightMagenta: "#c678dd",
    brightCyan: "#56b6c2",
    brightWhite: "#ffffff",
  },
}

const minimalLight: Theme = {
  name: "minimal-light",
  label: "Minimal Light",
  variant: "Light",
  scheme: "light",
  ui: {
    bg: "#fafafa",
    panel: "#f3f3f5",
    elev: "#e8e8ec",
    ...LIGHT_BORDERS,
    text: "#1d1d21",
    dim: "#5c5c66",
    faint: "#9a9aa3",
    accent: "#1f9d55",
    amber: "#b7791f",
    red: "#d33a47",
    blue: "#2f6fdb",
    ...LIGHT,
  },
  terminal: {
    background: "#fafafa",
    foreground: "#1d1d21",
    cursor: "#1f9d55",
    selectionBackground: "rgba(31,157,85,0.2)",
    black: "#2a2a2e",
    red: "#d33a47",
    green: "#1f8a4c",
    yellow: "#a86d14",
    blue: "#2f6fdb",
    magenta: "#9a3fc0",
    cyan: "#177e8c",
    white: "#b4b4bc",
    brightBlack: "#6e6e78",
    brightRed: "#e0525f",
    brightGreen: "#2a9d5c",
    brightYellow: "#c08424",
    brightBlue: "#4a86e8",
    brightMagenta: "#b25cd3",
    brightCyan: "#2394a4",
    brightWhite: "#cdcdd3",
  },
}

// ── Tokyo Night (Night / Day) ────────────────────────────
const tokyoNight: Theme = {
  name: "tokyo-night",
  label: "Tokyo Night",
  variant: "Night",
  scheme: "dark",
  ui: {
    bg: "#1a1b26",
    panel: "#16161e",
    elev: "#20212f",
    ...DARK_BORDERS,
    text: "#c0caf5",
    dim: "#7982a9",
    faint: "#565f89",
    accent: "#9ece6a",
    amber: "#e0af68",
    red: "#f7768e",
    blue: "#7aa2f7",
    ...DARK,
  },
  terminal: {
    background: "#1a1b26",
    foreground: "#c0caf5",
    cursor: "#9ece6a",
    selectionBackground: "rgba(122,162,247,0.25)",
    black: "#15161e",
    red: "#f7768e",
    green: "#9ece6a",
    yellow: "#e0af68",
    blue: "#7aa2f7",
    magenta: "#bb9af7",
    cyan: "#7dcfff",
    white: "#a9b1d6",
    brightBlack: "#414868",
    brightRed: "#f7768e",
    brightGreen: "#9ece6a",
    brightYellow: "#e0af68",
    brightBlue: "#7aa2f7",
    brightMagenta: "#bb9af7",
    brightCyan: "#7dcfff",
    brightWhite: "#c0caf5",
  },
}

const tokyoDay: Theme = {
  name: "tokyo-night-day",
  label: "Tokyo Night Day",
  variant: "Day",
  scheme: "light",
  ui: {
    bg: "#e1e2e7",
    panel: "#d5d6db",
    elev: "#c8cad6",
    ...LIGHT_BORDERS,
    text: "#3760bf",
    dim: "#6172b0",
    faint: "#8990b3",
    accent: "#587539",
    amber: "#8c6c3e",
    red: "#c64343",
    blue: "#2e7de9",
    ...LIGHT,
  },
  terminal: {
    background: "#e1e2e7",
    foreground: "#3760bf",
    cursor: "#3760bf",
    selectionBackground: "rgba(46,125,233,0.2)",
    // Official Day maps black to a near-background grey (invisible text); keep it dark.
    black: "#4c505e",
    red: "#c64343",
    green: "#587539",
    yellow: "#8c6c3e",
    blue: "#2e7de9",
    magenta: "#9854f1",
    cyan: "#007197",
    white: "#a1a6c5",
    brightBlack: "#6172b0",
    brightRed: "#f52a65",
    brightGreen: "#387068",
    brightYellow: "#965027",
    brightBlue: "#2e7de9",
    brightMagenta: "#7847bd",
    brightCyan: "#118c74",
    brightWhite: "#b4b8cf",
  },
}

// ── Catppuccin (Mocha / Latte) ───────────────────────────
const catppuccinMocha: Theme = {
  name: "catppuccin",
  label: "Catppuccin Mocha",
  variant: "Mocha",
  scheme: "dark",
  ui: {
    bg: "#1e1e2e",
    panel: "#181825",
    elev: "#313244",
    ...DARK_BORDERS,
    text: "#cdd6f4",
    dim: "#a6adc8",
    faint: "#6c7086",
    accent: "#a6e3a1",
    amber: "#f9e2af",
    red: "#f38ba8",
    blue: "#89b4fa",
    ...DARK,
  },
  terminal: {
    background: "#1e1e2e",
    foreground: "#cdd6f4",
    cursor: "#a6e3a1",
    selectionBackground: "rgba(137,180,250,0.25)",
    black: "#45475a",
    red: "#f38ba8",
    green: "#a6e3a1",
    yellow: "#f9e2af",
    blue: "#89b4fa",
    magenta: "#f5c2e7",
    cyan: "#94e2d5",
    white: "#bac2de",
    brightBlack: "#585b70",
    brightRed: "#f38ba8",
    brightGreen: "#a6e3a1",
    brightYellow: "#f9e2af",
    brightBlue: "#89b4fa",
    brightMagenta: "#f5c2e7",
    brightCyan: "#94e2d5",
    brightWhite: "#a6adc8",
  },
}

const catppuccinLatte: Theme = {
  name: "catppuccin-latte",
  label: "Catppuccin Latte",
  variant: "Latte",
  scheme: "light",
  ui: {
    bg: "#eff1f5",
    panel: "#e6e9ef",
    elev: "#dce0e8",
    ...LIGHT_BORDERS,
    text: "#4c4f69",
    dim: "#6c6f85",
    faint: "#9ca0b0",
    accent: "#40a02b",
    amber: "#df8e1d",
    red: "#d20f39",
    blue: "#1e66f5",
    ...LIGHT,
  },
  terminal: {
    background: "#eff1f5",
    foreground: "#4c4f69",
    cursor: "#dc8a78",
    selectionBackground: "rgba(30,102,245,0.18)",
    black: "#5c5f77",
    red: "#d20f39",
    green: "#40a02b",
    yellow: "#df8e1d",
    blue: "#1e66f5",
    magenta: "#ea76cb",
    cyan: "#179299",
    white: "#acb0be",
    brightBlack: "#6c6f85",
    brightRed: "#de293e",
    brightGreen: "#49af3d",
    brightYellow: "#eea02d",
    brightBlue: "#456eff",
    brightMagenta: "#fe85d8",
    brightCyan: "#2d9fa8",
    brightWhite: "#bcc0cc",
  },
}

// ── Gruvbox (Dark / Light) ───────────────────────────────
const gruvboxDark: Theme = {
  name: "gruvbox",
  label: "Gruvbox Dark",
  variant: "Dark",
  scheme: "dark",
  ui: {
    bg: "#1d2021",
    panel: "#282828",
    elev: "#32302f",
    ...DARK_BORDERS,
    text: "#ebdbb2",
    dim: "#a89984",
    faint: "#7c6f64",
    accent: "#b8bb26",
    amber: "#fabd2f",
    red: "#fb4934",
    blue: "#83a598",
    ...DARK,
  },
  terminal: {
    background: "#1d2021",
    foreground: "#ebdbb2",
    cursor: "#b8bb26",
    selectionBackground: "rgba(131,165,152,0.25)",
    black: "#282828",
    red: "#cc241d",
    green: "#98971a",
    yellow: "#d79921",
    blue: "#458588",
    magenta: "#b16286",
    cyan: "#689d6a",
    white: "#a89984",
    brightBlack: "#928374",
    brightRed: "#fb4934",
    brightGreen: "#b8bb26",
    brightYellow: "#fabd2f",
    brightBlue: "#83a598",
    brightMagenta: "#d3869b",
    brightCyan: "#8ec07c",
    brightWhite: "#ebdbb2",
  },
}

const gruvboxLight: Theme = {
  name: "gruvbox-light",
  label: "Gruvbox Light",
  variant: "Light",
  scheme: "light",
  ui: {
    bg: "#f9f5d7",
    panel: "#f2e5bc",
    elev: "#ebdbb2",
    ...LIGHT_BORDERS,
    text: "#3c3836",
    dim: "#665c54",
    faint: "#928374",
    accent: "#79740e",
    amber: "#b57614",
    red: "#9d0006",
    blue: "#076678",
    ...LIGHT,
  },
  terminal: {
    background: "#f9f5d7",
    foreground: "#3c3836",
    cursor: "#79740e",
    selectionBackground: "rgba(7,102,120,0.18)",
    black: "#3c3836",
    red: "#cc241d",
    green: "#98971a",
    yellow: "#d79921",
    blue: "#458588",
    magenta: "#b16286",
    cyan: "#689d6a",
    white: "#bdae93",
    brightBlack: "#7c6f64",
    brightRed: "#9d0006",
    brightGreen: "#79740e",
    brightYellow: "#b57614",
    brightBlue: "#076678",
    brightMagenta: "#8f3f71",
    brightCyan: "#427b58",
    brightWhite: "#d5c4a1",
  },
}

export const THEME_FAMILIES: Record<string, ThemeFamily> = {
  minimal: { name: "minimal", label: "Minimal", dark: minimalDark, light: minimalLight },
  "tokyo-night": { name: "tokyo-night", label: "Tokyo Night", dark: tokyoNight, light: tokyoDay },
  catppuccin: {
    name: "catppuccin",
    label: "Catppuccin",
    dark: catppuccinMocha,
    light: catppuccinLatte,
  },
  gruvbox: { name: "gruvbox", label: "Gruvbox", dark: gruvboxDark, light: gruvboxLight },
}

export const DEFAULT_THEME_FAMILY = "minimal"

// Pre-families names (settings written by older builds) → family.
const LEGACY_FAMILY: Record<string, string> = { "minimal-dark": "minimal" }

/** A variant's own name ("catppuccin-latte") → its family + scheme; null if not a variant. */
export function variantOf(name: string): { family: string; scheme: "dark" | "light" } | null {
  for (const f of Object.values(THEME_FAMILIES)) {
    if (f.light.name === name) return { family: f.name, scheme: "light" }
    if (f.dark.name === name) return { family: f.name, scheme: "dark" }
  }
  return null
}

/** The family name for a stored `theme` value (legacy/variant names mapped; unknown → default). */
export function themeFamilyName(name: string): string {
  const n = LEGACY_FAMILY[name] ?? name
  if (n in THEME_FAMILIES) return n
  return variantOf(n)?.family ?? DEFAULT_THEME_FAMILY
}

/** `#rrggbb` + alpha → `rgba(…)` (xterm decorations take plain colours, not color-mix). */
export function withAlpha(hex: string, alpha: number): string {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex)
  if (!m) return hex
  const [r, g, b] = m.slice(1).map((h) => parseInt(h, 16))
  return `rgba(${r},${g},${b},${alpha})`
}

/** The concrete scheme for an appearance (`system` follows the OS preference). */
export const resolveScheme = (appearance: Appearance, systemDark: boolean): "dark" | "light" =>
  appearance === "system" ? (systemDark ? "dark" : "light") : appearance

/** The theme to render: the family's variant for the (resolved) appearance. */
export function resolveTheme(name: string, appearance: Appearance, systemDark: boolean): Theme {
  return THEME_FAMILIES[themeFamilyName(name)]![resolveScheme(appearance, systemDark)]
}

// Read back by the inline script in index.html before the first paint (keep the shape).
const CACHE_KEY = "minmux:theme-vars"

/** Push a theme's UI tokens onto :root as CSS vars (+ cache them for index.html's first paint). */
export function applyThemeVars(theme: Theme) {
  const vars: Record<string, string> = {}
  for (const [key, value] of Object.entries(theme.ui)) {
    // camelCase token → --kebab-case CSS var (border2 → --border2).
    vars[`--${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`] = value
  }
  writeRootVars(vars, theme.scheme)
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ vars, scheme: theme.scheme }))
  } catch {
    // storage unavailable — first paint just uses the CSS defaults
  }
}

function writeRootVars(vars: Record<string, string>, scheme: "dark" | "light") {
  const root = document.documentElement
  for (const [name, value] of Object.entries(vars)) root.style.setProperty(name, value)
  root.style.colorScheme = scheme
  root.dataset.scheme = scheme
}
