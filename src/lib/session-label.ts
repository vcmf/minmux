import { allSessionIds } from "./pane-tree"
import type { Session, Tab } from "../types"

/** Short shell-type label for the badge (zsh/bash/pwsh/wsl/…) from the command. */
export function shellType(command: string): string {
  const base = (command.split(/[\\/]/).pop() || "").replace(/\.exe$/i, "")
  if (base === "powershell") return "pwsh"
  return base || "shell"
}

/** Home-relative, compact cwd for sublines (…/a/b tail, "~" for $HOME). */
export function shortCwd(cwd: string | undefined, home: string): string {
  if (!cwd) return ""
  return home && (cwd === home || cwd.startsWith(home + "/")) ? "~" + cwd.slice(home.length) : cwd
}

/** Last path segment of a cwd ("~" at $HOME) — the default title headline. */
export function cwdBasename(cwd: string | undefined, home: string): string {
  if (!cwd || cwd === home) return cwd === home ? "~" : ""
  return cwd.split(/[\\/]/).filter(Boolean).pop() || ""
}

/** A program-set title is "custom" (worth showing) if it isn't the shell's
 *  default noise — i.e. not a user@host:path banner and not a bare path. */
export function isCustomOscTitle(title: string | undefined): boolean {
  if (!title) return false
  const t = title.trim()
  if (!t) return false
  if (/.+@.+:/.test(t)) return false // user@host:cwd
  if (t.includes("/") || t.startsWith("~")) return false // looks like a path
  return true
}

/** A pane's display title: custom program title > ssh host > cwd basename > shell name. */
export function displaySessionTitle(session: Session | undefined, home: string): string {
  if (!session) return "shell"
  if (isCustomOscTitle(session.oscTitle)) return session.oscTitle!.trim()
  if (session.remote) return session.remote.label
  return cwdBasename(session.cwd, home) || shellType(session.command) || session.title || "shell"
}

/** A tab's display title: the manual pin (tab.title) if set, else the focused pane's live
 *  title — and when its panes run on more than one place (hosts, or a host and this machine),
 *  how many others: "gpu-box +1". */
export function tabTitle(tab: Tab, sessions: Record<string, Session>, home: string): string {
  const { base, more } = tabTitleParts(tab, sessions, home)
  return more ? `${base} ${more}` : base
}

/** tabTitle in two parts, so a long title can ellipsize without losing its "+N". */
export function tabTitleParts(
  tab: Tab,
  sessions: Record<string, Session>,
  home: string,
): { base: string; more?: string } {
  const pinned = tab.title.trim()
  if (pinned) return { base: pinned }
  const base = displaySessionTitle(sessions[tab.activeSessionId], home)
  const places = new Set<string>()
  let remote = false
  for (const id of allSessionIds(tab.root)) {
    const s = sessions[id]
    if (!s) continue
    if (s.remote) remote = true
    places.add(s.remote ? s.remote.hostId : "local")
  }
  return remote && places.size > 1 ? { base, more: `+${places.size - 1}` } : { base }
}

/** "branch • ~/dir" (branch optional) for a session's subline. */
export function sessionSubline(cwd: string | undefined, home: string, branch?: string): string {
  return branchLine(branch, shortCwd(cwd, home))
}

/** "branch • dir" (either part may be missing). */
export function branchLine(branch: string | undefined, dir: string): string {
  if (branch && dir) return `${branch} • ${dir}`
  return branch || dir
}
