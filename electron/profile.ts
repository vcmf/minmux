// Which smterm "profile" this process is: its app name, config dir, Electron user-data dir,
// single-instance lock and shell-integration dir. A dev build (`make run`) is the `dev`
// profile by default, so it runs beside an installed smterm without sharing any of its
// state. SMTERM_PROFILE picks another one (docs/GOTCHAS.md#profiles).

/** The installed app's profile — the plain `smterm` names and dirs. */
export const DEFAULT_PROFILE = ""

// Lowercase letters, digits and `-`: it becomes part of a directory name.
const PROFILE_RE = /^[a-z0-9][a-z0-9-]{0,31}$/

/** The profile SMTERM_PROFILE names (else `dev` unpackaged, default packaged); error if invalid. */
export function resolveProfile(
  env: string | undefined,
  packaged: boolean,
): { profile: string } | { error: string } {
  const v = env?.trim().toLowerCase()
  if (!v) return { profile: packaged ? DEFAULT_PROFILE : "dev" }
  if (v === "default" || v === "prod") return { profile: DEFAULT_PROFILE }
  if (PROFILE_RE.test(v)) return { profile: v }
  // Never guess: falling back could open another profile's (or the real) settings and layout.
  return {
    error: `SMTERM_PROFILE="${env}" isn't a valid profile name (use lowercase letters, digits and -, up to 32).`,
  }
}

export interface ProfileNames {
  appName: string // app.setName + the config / user-data / temp dir name ("smterm-dev")
  label: string // shown in the UI and window title ("" for the default profile)
}

export function profileNames(profile: string): ProfileNames {
  return profile
    ? { appName: `smterm-${profile}`, label: profile }
    : { appName: "smterm", label: "" }
}

/** What a window, dialog or dock says this instance is: "smterm" / "smterm (dev)". */
export const displayName = (n: ProfileNames): string => (n.label ? `smterm (${n.label})` : "smterm")

// Set per pane by the smterm that spawned a shell. A smterm started from such a shell must
// not inherit them: they point at the parent's hook files, pane ids and integration dir.
const PARENT_INSTANCE_VARS = [
  "SMTERM_PROFILE",
  "SMTERM_CLAUDE_SETTINGS",
  "SMTERM_PANE_ID",
  "SMTERM_SHARE_HISTORY",
  "SMTERM_SHELL_INTEGRATION",
  "SMTERM_ZDOTDIR",
  "SMTERM_USER_ZDOTDIR",
]

/** Drop a parent smterm's per-pane vars from `env` (in place); returns the names removed. */
export function scrubParentInstanceEnv(env: Record<string, string | undefined>): string[] {
  const removed = PARENT_INSTANCE_VARS.filter((k) => env[k] !== undefined)
  for (const k of removed) delete env[k]
  return removed
}
