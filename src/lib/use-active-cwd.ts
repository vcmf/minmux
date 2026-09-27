import { useStore } from "../store"
import { wslContext, type WslContext } from "./wsl"
import { workCwd } from "./agent-dirs"
import type { RemoteRef } from "../types"

/** The folder the focused pane works in: Claude's while it runs there (a worktree, a `cd`),
 *  else the shell's — drives the git status bar + changes panel. None for an ssh session:
 *  its folders are on the host, so nothing local may read them. */
export function useActiveWorkCwd(): string | undefined {
  return useStore((s) => {
    const tab = s.tabs.find((t) => t.id === s.activeTabId)
    const sid = tab?.activeSessionId
    const session = sid ? s.sessions[sid] : undefined
    if (!sid || session?.remote) return undefined
    return workCwd(s.agents, s.paneGit, sid, session?.cwd)
  })
}

/** The focused session's ssh host, if it's remote (the panels show a notice instead). */
export function useActiveRemote(): RemoteRef | undefined {
  return useStore((s) => {
    const sid = s.tabs.find((t) => t.id === s.activeTabId)?.activeSessionId
    return sid ? s.sessions[sid]?.remote : undefined
  })
}

/** The focused session's id (keys the per-pane Files-panel root override). */
export function useActiveSessionId(): string | undefined {
  return useStore((s) => s.tabs.find((t) => t.id === s.activeTabId)?.activeSessionId)
}

/** The Files-panel root for the focused pane: the per-session override if set, else the
 *  live cwd. `diverged` = an override that no longer matches the terminal's cwd (drives
 *  the amber reset button). `sessionId` is needed to set/clear the override. */
export function useFilesRoot(): {
  root: string | undefined
  cwd: string | undefined
  sessionId: string | undefined
  diverged: boolean
} {
  // Claude's checkout while it works in another one — the same repo the git badges come from.
  const cwd = useActiveWorkCwd()
  const sessionId = useActiveSessionId()
  const override = useStore((s) =>
    sessionId && !s.sessions[sessionId]?.remote ? s.paneRoot[sessionId] : undefined,
  )
  return { root: override ?? cwd, cwd, sessionId, diverged: !!override && override !== cwd }
}

/** Non-reactive: the focused session's WSL context (so git runs inside the distro),
 *  or undefined for a native shell. Read at git-call time — it tracks the same
 *  session as the cwd, so it needn't be a reactive dependency. */
export function getActiveWsl(): WslContext | undefined {
  const s = useStore.getState()
  const tab = s.tabs.find((t) => t.id === s.activeTabId)
  const sess = tab?.activeSessionId ? s.sessions[tab.activeSessionId] : undefined
  return sess ? wslContext(sess.command, sess.args) : undefined
}
