import { useStore } from "../store"
import { wslContext, type WslContext } from "./wsl"
import { workCwd } from "./agent-dirs"

type State = ReturnType<typeof useStore.getState>

/** The focused session's id (the active tab's), if any. */
const focusedId = (s: State): string | undefined =>
  s.tabs.find((t) => t.id === s.activeTabId)?.activeSessionId

/** The folder the focused pane works in: Claude's while it runs there (a worktree, a `cd`),
 *  else the shell's — drives the git status bar (and folder / file tabs in its repo). None for an ssh session:
 *  its folders are on the host, so nothing local may read them. */
export function useActiveWorkCwd(): string | undefined {
  return useStore((s) => {
    const sid = focusedId(s)
    const session = sid ? s.sessions[sid] : undefined
    if (!sid || session?.remote) return undefined
    return workCwd(s.agents, s.paneGit, sid, session?.cwd)
  })
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
