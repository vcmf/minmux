// Which smterm "profile" this process is: its app name, config dir, Electron user-data dir
// and single-instance lock. A dev build (`make run`) is the `dev` profile by default, so it
// runs beside an installed smterm without sharing its lock, settings, workspace or Claude
// hook files. SMTERM_PROFILE picks another one (see docs/GOTCHAS.md#profiles).

/** The installed app's profile — the plain `smterm` names and dirs. */
export const DEFAULT_PROFILE = ""

// Lowercase letters, digits and `-`: it becomes part of a directory and an app id.
const PROFILE_RE = /^[a-z0-9][a-z0-9-]{0,31}$/

/** SMTERM_PROFILE if set and valid ("default" / "prod" = the installed app's), else `dev`
 *  for an unpackaged build and the default for a packaged one. */
export function resolveProfile(env: string | undefined, packaged: boolean): string {
  const v = env?.trim().toLowerCase()
  if (v === "default" || v === "prod") return DEFAULT_PROFILE
  if (v && PROFILE_RE.test(v)) return v
  return packaged ? DEFAULT_PROFILE : "dev"
}

export interface ProfileNames {
  appName: string // app.setName + the config / user-data dir name ("smterm" / "smterm-dev")
  appId: string // Windows AppUserModelId: taskbar grouping + notifications
  label: string // shown in the UI next to the brand ("" for the default profile)
}

export function profileNames(profile: string): ProfileNames {
  if (!profile) return { appName: "smterm", appId: "com.smterm.app", label: "" }
  return {
    appName: `smterm-${profile}`,
    appId: `com.smterm.app.${profile}`,
    label: profile,
  }
}
