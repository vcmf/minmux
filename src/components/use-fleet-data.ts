// The Fleet tab's hooks: the data refresher (lib/fleet-refresh) wired to the app, and the model
// over a throttled view of the store (the graph isn't live: following it once a second is plenty).
import { useEffect, useMemo, useState, useSyncExternalStore } from "react"
import { useStore, type AppState } from "../store"
import { ipc } from "../lib/ipc"
import { fleetModel, type FleetRepo } from "../lib/fleet-model"
import { FleetRefresh, type FleetData } from "../lib/fleet-refresh"
import { forgetRoots, rootsOf, splitRoots } from "../lib/pane-roots"
import type { PaneGitInfo } from "../lib/pane-git"
import type { Session } from "../types"

// The panes' host roots (WSL and ssh panes have none main's git can read), memoized on the maps.
let rootsMemo: { paneGit: unknown; sessions: unknown; roots: string[] } | null = null
function hostRoots(paneGit: Record<string, PaneGitInfo>, sessions: Record<string, Session>) {
  if (rootsMemo?.paneGit === paneGit && rootsMemo.sessions === sessions) return rootsMemo.roots
  rootsMemo = { paneGit, sessions, roots: splitRoots(rootsOf(paneGit, sessions)).host }
  return rootsMemo.roots
}
const currentRoots = () => {
  const s = useStore.getState()
  return hostRoots(s.paneGit, s.sessions)
}

const refresh = new FleetRefresh({
  prLocal: (req) => ipc.prLocal(req),
  prLists: (req) => ipc.prLists(req),
  roots: currentRoots,
  hidden: () => document.visibilityState === "hidden",
  now: () => Date.now(),
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
})

/** The fleet's data; mounted, it keeps the refresher running (roots changes, window shown). */
export function useFleetData(): FleetData {
  const data = useSyncExternalStore(refresh.subscribe, refresh.get)
  useEffect(() => {
    let key = currentRoots().join("\n")
    const unsub = useStore.subscribe((s, prev) => {
      if (s.paneGit === prev.paneGit && s.sessions === prev.sessions) return
      const next = hostRoots(s.paneGit, s.sessions).join("\n")
      if (next === key) return
      key = next
      refresh.rootsChanged()
    })
    const onVisible = () => {
      if (document.visibilityState !== "hidden") refresh.shown()
    }
    document.addEventListener("visibilitychange", onVisible)
    return () => {
      unsub()
      document.removeEventListener("visibilitychange", onVisible)
      rootsMemo = null // (both hold the store's maps)
      forgetRoots()
    }
  }, [])
  return data
}

type Slices = Pick<AppState, "agents" | "paneGit" | "sessions" | "agentMeta" | "paneWork">
const slices = (s: AppState): Slices => ({
  agents: s.agents,
  paneGit: s.paneGit,
  sessions: s.sessions,
  agentMeta: s.agentMeta,
  paneWork: s.paneWork,
})
const sameSlices = (a: Slices, b: AppState) =>
  a.agents === b.agents &&
  a.paneGit === b.paneGit &&
  a.sessions === b.sessions &&
  a.agentMeta === b.agentMeta &&
  a.paneWork === b.paneWork

/** The store slices the fleet reads, followed together at most once per `ms` (one wake-up). */
export function useThrottledSlices(ms: number): Slices {
  const [value, setValue] = useState(() => slices(useStore.getState()))
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    let last = 0
    let shown = value
    const later = () => {
      if (timer) return
      timer = setTimeout(
        () => {
          timer = undefined
          last = Date.now()
          shown = slices(useStore.getState())
          setValue(shown)
        },
        Math.max(0, last + ms - Date.now()),
      )
    }
    const unsub = useStore.subscribe((state) => {
      if (!sameSlices(shown, state)) later()
    })
    // A change between the first render and this subscription isn't missed.
    if (!sameSlices(shown, useStore.getState())) later()
    return () => {
      unsub()
      clearTimeout(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `value` only seeds `shown`
  }, [ms])
  return value
}

/** The fleet model, following the store at most once a second. */
export function useFleetModel(): FleetRepo[] {
  const { local, mine } = useFleetData()
  const { agents, paneGit, sessions, agentMeta, paneWork } = useThrottledSlices(1000)
  return useMemo(
    () => fleetModel({ agents, paneGit, sessions, paneWork, meta: agentMeta, local, mine }),
    [agents, paneGit, sessions, paneWork, agentMeta, local, mine],
  )
}
