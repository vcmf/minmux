// The panes' checkout roots for `prs:local` (the PR dialog and the Fleet tab), memoized on the
// last paneGit and sessions maps (one slot, shared; `forgetRoots` drops it).
import { paneOfGitKey } from "./agent-dirs"
import { ghEnvOf } from "./open-link"
import { hostPathOfWsl } from "./pr-local"
import type { PaneGitInfo } from "./pane-git"
import type { Session } from "../types"

// The panes' checkout roots (their shells' and their agents'), as one primitive the shallow
// compare can hold: host roots (asked about), then a tab, then every root a pane is in, a WSL
// pane's `/mnt/c/…` as `C:/…` (a worktree a WSL pane has open isn't offered again).
// Recomputed only when paneGit or sessions change.
let rootsMemo: { args: unknown[]; out: string } | null = null
export function rootsOf(paneGit: Record<string, PaneGitInfo>, sessions: Record<string, Session>) {
  const args = [paneGit, sessions]
  if (rootsMemo && rootsMemo.args.every((a, i) => a === args[i])) return rootsMemo.out
  const host = new Set<string>()
  const known = new Set<string>()
  for (const [key, info] of Object.entries(paneGit)) {
    const session = sessions[paneOfGitKey(key)]
    if (!info.root || !session || session.remote) continue // (an ssh pane: nothing local)
    // (WSL's roots are Linux paths main's git can't read: host checkouts only, for now)
    if (ghEnvOf(session, info.root).wsl) known.add(hostPathOfWsl(info.root) ?? info.root)
    else {
      host.add(info.root)
      known.add(info.root)
    }
  }
  rootsMemo = { args, out: `${[...host].sort().join("\n")}\t${[...known].sort().join("\n")}` }
  return rootsMemo.out
}
export const splitRoots = (key: string) => {
  const [host = "", known = ""] = key.split("\t")
  return { host: host ? host.split("\n") : [], known: known ? known.split("\n") : [] }
}

/** Drop the memo (its maps hold the store's last paneGit and sessions). */
export function forgetRoots(): void {
  rootsMemo = null
}
