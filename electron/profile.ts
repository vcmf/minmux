// Which minmux "profile" this process is: its app name, config dir, Electron user-data dir,
// single-instance lock and shell-integration dir. A dev build (`make run`) is the `dev`
// profile by default, so it runs beside an installed minmux without sharing any of its
// state. `--profile=<name>` picks another one; a dev build also takes MINMUX_PROFILE, an
// installed one never does (docs/GOTCHAS.md#profiles).

/** The installed app's profile — the plain `minmux` names and dirs. */
export const DEFAULT_PROFILE = ""

// Lowercase letters, digits and `-`: it becomes part of a directory name.
const PROFILE_RE = /^[a-z0-9][a-z0-9-]{0,31}$/

/** This process's profile: `--profile=` wins; MINMUX_PROFILE only for a dev build (an
 *  installed app ignores ambient env); else `dev` unpackaged, default packaged. */
export function resolveProfile(o: {
  flag?: string // --profile=<name> (undefined = not passed)
  env?: string // MINMUX_PROFILE
  packaged: boolean
}): { profile: string } | { error: string } {
  if (o.flag !== undefined) return parseName(o.flag, "--profile")
  if (!o.packaged && o.env?.trim()) return parseName(o.env, "MINMUX_PROFILE")
  return { profile: o.packaged ? DEFAULT_PROFILE : "dev" }
}

function parseName(raw: string, source: string): { profile: string } | { error: string } {
  const v = raw.trim().toLowerCase()
  if (v === "default" || v === "prod") return { profile: DEFAULT_PROFILE }
  if (PROFILE_RE.test(v)) return { profile: v }
  // Never guess: falling back could open another profile's (or the real) settings and layout.
  return {
    error: `${source}="${raw}" isn't a valid profile name (use lowercase letters, digits and -, up to 32).`,
  }
}

export interface ProfileNames {
  appName: string // app.setName + the config / user-data / temp dir name ("minmux-dev")
  label: string // shown in the UI and window title ("" for the default profile)
}

export function profileNames(profile: string): ProfileNames {
  return profile
    ? { appName: `minmux-${profile}`, label: profile }
    : { appName: "minmux", label: "" }
}

/** What a window, dialog or dock says this instance is: "minmux" / "minmux (dev)". */
export const displayName = (n: ProfileNames): string => (n.label ? `minmux (${n.label})` : "minmux")

// Set per pane by the minmux that spawned a shell. A minmux started from such a shell must
// not inherit them: they point at the parent's hook files, pane ids and integration dir.
const PARENT_INSTANCE_VARS = [
  "MINMUX_PROFILE",
  "MINMUX_CLAUDE_SETTINGS",
  "MINMUX_PANE_ID",
  "MINMUX_SHARE_HISTORY",
  "MINMUX_SHELL_INTEGRATION",
  "MINMUX_ZDOTDIR",
  "MINMUX_USER_ZDOTDIR",
]
// The same vars under the app's old name: a minmux started from a pane an smterm spawned.
const LEGACY_INSTANCE_VARS = PARENT_INSTANCE_VARS.map((k) => k.replace(/^MINMUX_/, "SMTERM_"))

/** Drop a parent minmux's per-pane vars from `env` (in place); returns the names removed. */
export function scrubParentInstanceEnv(env: Record<string, string | undefined>): string[] {
  const removed = [...PARENT_INSTANCE_VARS, ...LEGACY_INSTANCE_VARS].filter(
    (k) => env[k] !== undefined,
  )
  for (const k of removed) delete env[k]
  return removed
}
