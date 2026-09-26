import { DEFAULT_THEME_FAMILY, themeFamilyName, variantOf, type Appearance } from "./themes"
import { hasControlChar } from "../lib/control-chars"

export { validateSshHosts, type SshHostSetting } from "../lib/ssh-validate"

export interface SshSettings {
  fromSshConfig: boolean // list ~/.ssh/config hosts
  reuseConnections: boolean // OpenSSH ControlMaster so later panes skip auth
  hidden: string[] // aliases / names hidden from the list
  // Exactly as written in settings.json — validated where used (validateSshHosts), never
  // here, so re-saving settings can't erase an entry the user got slightly wrong.
  hosts: unknown[]
}

export interface Settings {
  font: {
    family: string
    size: number
    ligatures: boolean
    lineHeight: number
  }
  theme: string // theme family ("minimal", "tokyo-night", …) — each has a dark + light variant
  appearance: Appearance // which variant: "dark" | "light" | "system" (follow the OS)
  // GPU acceleration (like VS Code's gpuAcceleration): "webgl" = WebGL on every visible
  // pane (default; crisp glyphs everywhere); "dom" = no GPU (fallback for GPUs/drivers
  // that can't hold multiple contexts cleanly).
  renderer: "webgl" | "dom"
  cursorBlink: boolean
  scrollback: number
  confirmQuit: boolean
  shareHistory: boolean // cmux-like shared, incrementally-written zsh/bash history across panes
  shiftEnterNewline: boolean // Shift+Enter sends CSI-u (newline in Claude Code etc.); off = normal submit
  defaultShell: string // command path of the preferred shell; "" = system $SHELL
  fileLinks: boolean // click file paths in output to open them
  openPath: string // editor command for clicked paths; "" = OS default. {file}/{line}/{col}
  resumeAgents: "auto" | "ask" | "off" // on relaunch, resume the Claude session each pane was in
  resumeBypassPermissions: boolean // also restore --permission-mode bypassPermissions (else default)
  ssh: SshSettings
}

export const defaultSettings: Settings = {
  // FiraCode Nerd Font Mono has BOTH ligatures and Nerd/Powerline icons in one
  // font (xterm's canvas renderer doesn't fall back per-glyph, so the primary
  // font must carry the icons). Falls back to bundled JetBrains Mono if absent.
  // Ligatures default OFF: the WebGL renderer + ligature joiner leaves paint
  // remnants → garbled glyphs with multiple panes (xterm.js #3303). Opt in if you
  // don't hit it. See ARCHITECTURE §9a / the rendering notes.
  font: { family: "FiraCode Nerd Font Mono", size: 13, ligatures: false, lineHeight: 1.2 },
  theme: DEFAULT_THEME_FAMILY,
  appearance: "dark",
  renderer: "webgl",
  cursorBlink: true,
  scrollback: 5000,
  confirmQuit: true,
  shareHistory: true,
  shiftEnterNewline: true,
  defaultShell: "",
  fileLinks: true,
  openPath: "code -g {file}:{line}:{col}",
  resumeAgents: "auto",
  resumeBypassPermissions: false,
  ssh: { fromSshConfig: true, reuseConnections: true, hidden: [], hosts: [] },
}

const num = (v: unknown, fallback: number, min: number, max: number): number =>
  typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback

const bool = (v: unknown, fallback: boolean): boolean => (typeof v === "boolean" ? v : fallback)

const str = (v: unknown, fallback: string): string =>
  typeof v === "string" && v.trim().length > 0 ? v : fallback

const asObject = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" ? (v as Record<string, unknown>) : {}

const MAX_SSH_HIDDEN = 1000

/** The `ssh` block: booleans and `hidden` validated, `hosts` kept verbatim. */
export function mergeSshSettings(input: unknown): SshSettings {
  const o = asObject(input)
  const d = defaultSettings.ssh
  // A JSON round-trip copies the entries (and drops anything JSON can't hold).
  let hosts: unknown[] = []
  try {
    if (Array.isArray(o.hosts)) hosts = JSON.parse(JSON.stringify(o.hosts)) as unknown[]
  } catch {
    // cyclic / BigInt input can't be stored as JSON anyway
  }
  const hidden = Array.isArray(o.hidden)
    ? [
        ...new Set(
          o.hidden
            .filter((x): x is string => typeof x === "string")
            .map((x) => x.trim())
            .filter((x) => x !== "" && x.length <= 255 && !hasControlChar(x)),
        ),
      ].slice(0, MAX_SSH_HIDDEN)
    : []
  return {
    fromSshConfig: bool(o.fromSshConfig, d.fromSshConfig),
    reuseConnections: bool(o.reuseConnections, d.reuseConnections),
    hidden,
    hosts,
  }
}

/** Deep-merge arbitrary input over defaults, validating + clamping. Unknown keys ignored. */
export function mergeSettings(input: unknown): Settings {
  const o = asObject(input)
  const f = asObject(o.font)
  const d = defaultSettings
  // A variant name ("gruvbox-light") picks its family and — unless set explicitly — its scheme.
  const variant = typeof o.theme === "string" ? variantOf(o.theme) : null
  return {
    font: {
      family: str(f.family, d.font.family),
      size: num(f.size, d.font.size, 6, 72),
      ligatures: bool(f.ligatures, d.font.ligatures),
      lineHeight: num(f.lineHeight, d.font.lineHeight, 1, 3),
    },
    theme: themeFamilyName(str(o.theme, d.theme)), // legacy "minimal-dark" → "minimal"
    appearance:
      o.appearance === "light" || o.appearance === "system" || o.appearance === "dark"
        ? o.appearance
        : (variant?.scheme ?? d.appearance),
    renderer: o.renderer === "dom" ? "dom" : "webgl",
    cursorBlink: bool(o.cursorBlink, d.cursorBlink),
    scrollback: num(o.scrollback, d.scrollback, 0, 1_000_000),
    confirmQuit: bool(o.confirmQuit, d.confirmQuit),
    shareHistory: bool(o.shareHistory, d.shareHistory),
    shiftEnterNewline: bool(o.shiftEnterNewline, d.shiftEnterNewline),
    defaultShell: typeof o.defaultShell === "string" ? o.defaultShell : d.defaultShell,
    fileLinks: bool(o.fileLinks, d.fileLinks),
    // Allow "" (OS default), so don't use str() which rejects empty strings.
    openPath: typeof o.openPath === "string" ? o.openPath : d.openPath,
    resumeAgents:
      o.resumeAgents === "ask" || o.resumeAgents === "off" || o.resumeAgents === "auto"
        ? o.resumeAgents
        : d.resumeAgents,
    resumeBypassPermissions: bool(o.resumeBypassPermissions, d.resumeBypassPermissions),
    ssh: mergeSshSettings(o.ssh),
  }
}

/** Tolerant parse of the raw settings file: bad/empty JSON → defaults, never throws. */
export function parseSettings(raw: string): Settings {
  if (!raw.trim()) return defaultSettings
  try {
    return mergeSettings(JSON.parse(raw))
  } catch {
    return defaultSettings
  }
}

export function serializeSettings(s: Settings): string {
  return `${JSON.stringify(s, null, 2)}\n`
}
