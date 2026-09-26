import { DEFAULT_THEME_FAMILY, themeFamilyName, variantOf, type Appearance } from "./themes"
import type { SshEnv } from "../types"
import { hasControlChar, isSshEnv, isSshOptionList, isSshTarget } from "../lib/ssh-validate"

/** A host defined in settings.json (in addition to ~/.ssh/config). */
export interface SshHostSetting {
  name: string // label + stable id
  target: string // ssh destination (alias or user@host)
  args: string[] // extra ssh flags, e.g. ["-p", "2222"]
  env: SshEnv // which ssh runs it ("native", or "wsl:<distro>" on Windows)
}

export interface SshSettings {
  fromSshConfig: boolean // list ~/.ssh/config hosts
  reuseConnections: boolean // OpenSSH ControlMaster so later panes skip auth
  hidden: string[] // aliases / names hidden from the list
  hosts: SshHostSetting[]
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

const MAX_SSH_HOSTS = 500
const MAX_SSH_ARGS = 32
const MAX_SSH_HIDDEN = 1000

/** One settings host, or null if any part is invalid (dropped whole, never half-kept). */
function sshHostSetting(v: unknown): SshHostSetting | null {
  const o = asObject(v)
  const name = typeof o.name === "string" ? o.name.trim() : ""
  if (!name || name.length > 80 || hasControlChar(name)) return null
  if (!isSshTarget(o.target)) return null
  let args: string[] = []
  if (o.args !== undefined) {
    if (!Array.isArray(o.args) || o.args.length > MAX_SSH_ARGS) return null
    if (!isSshOptionList(o.args)) return null
    args = o.args as string[]
  }
  let env: SshEnv = "native"
  if (o.env !== undefined && o.env !== "native") {
    if (!isSshEnv(o.env)) return null
    env = o.env
  }
  return { name, target: o.target, args, env }
}

/** Validate the `ssh` block: bad hosts dropped, duplicate names keep the first. */
export function mergeSshSettings(input: unknown): SshSettings {
  const o = asObject(input)
  const d = defaultSettings.ssh
  const hosts: SshHostSetting[] = []
  const names = new Set<string>()
  for (const raw of Array.isArray(o.hosts) ? o.hosts.slice(0, MAX_SSH_HOSTS) : []) {
    const h = sshHostSetting(raw)
    if (!h || names.has(h.name)) continue
    names.add(h.name)
    hosts.push(h)
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
