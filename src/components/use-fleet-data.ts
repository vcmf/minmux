// The fleet's data beyond the store (docs/design/FLEET_GRAPH.md, "Data"): each repo's GitHub
// name, worktrees and default branch (prs:local), and my open PRs (the lists' `mine`). Asked
// only while the Fleet tab is mounted and the window is visible, at the PR dialog's cadence.
import { useEffect, useMemo, useRef, useState } from "react"
import { useStore, type AppState } from "../store"
import { ipc } from "../lib/ipc"
import { fleetModel, type FleetRepo } from "../lib/fleet-model"
import { nextRefreshMs, type PrLists, type PrRow } from "../lib/pr-dashboard"
import type { LocalRepo } from "../lib/pr-local"
import { rootsOf, splitRoots } from "../lib/pane-roots"

interface FleetData {
  local: LocalRepo[]
  mine: PrRow[]
}

// Kept across mounts: reopening the tab shows the last answers at once, and switching tabs back
// and forth neither asks GitHub again before the cadence says so nor forgets a failure's backoff.
let cache: FleetData = { local: [], mine: [] }
let lastLists: PrLists | null = null
let lastAsked = 0 // when the last refresh ran (0: never)
let failures = 0
let localAsked = 0 // prs:local requests started…
let localWritten = 0 // …and the newest one whose answer was kept (an older one landing later isn't)
let localStale = false // the roots changed while the window was hidden: ask once it shows

/** The panes' host checkout roots (WSL and ssh panes left out, as the PR dialog does). */
const hostRoots = () => {
  const s = useStore.getState()
  return splitRoots(rootsOf(s.paneGit, s.sessions)).host
}

async function askLocal(roots: string[]): Promise<boolean> {
  if (!roots.length) return false
  const seq = ++localAsked
  const r = await ipc.prLocal({ roots }).catch(() => null)
  if (!r?.ok || seq < localWritten) return false
  localWritten = seq
  localStale = false
  cache = { ...cache, local: r.repos }
  return true
}

async function askMine(): Promise<boolean> {
  const r = await ipc.prLists({ closed: false, part: "mine" }).catch(() => null)
  if (!r?.ok) {
    failures++
    return false
  }
  failures = 0
  lastLists = r.lists
  cache = { ...cache, mine: r.lists.mine }
  return true
}

export function useFleetData(): FleetData {
  const [data, setData] = useState(cache)
  const rootsKey = useStore((s) => rootsOf(s.paneGit, s.sessions).split("\t")[0]!)

  // Repos, as soon as the set of roots changes (main caches names; worktrees are re-read); while
  // the window is hidden, once it shows.
  useEffect(() => {
    if (document.visibilityState === "hidden") {
      localStale = true
      return
    }
    let stale = false
    void askLocal(rootsKey ? rootsKey.split("\n") : []).then((ok) => {
      if (ok && !stale) setData(cache)
    })
    return () => {
      stale = true
    }
  }, [rootsKey])

  // Both, at the dialog's cadence (slower after failures or on a low GraphQL budget): a failed
  // repo lookup is retried there too. On mount, only once the cadence since the last refresh is
  // up; on the window showing again, at once when it's overdue.
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => {
    let stop = false
    const due = () => lastAsked + nextRefreshMs(lastLists, failures) - Date.now()
    const schedule = () => {
      clearTimeout(timer.current)
      if (!stop) timer.current = setTimeout(() => void tick(), Math.max(0, due()))
    }
    const tick = async () => {
      if (document.visibilityState === "hidden") return // the visibility listener resumes it
      lastAsked = Date.now()
      await Promise.all([askLocal(hostRoots()), askMine()])
      if (stop) return
      setData(cache)
      schedule()
    }
    const onVisible = () => {
      if (document.visibilityState === "hidden") return
      if (due() <= 0) void tick()
      else if (localStale)
        void askLocal(hostRoots()).then((ok) => {
          if (ok && !stop) setData(cache)
        })
    }
    if (due() <= 0) void tick()
    else schedule()
    document.addEventListener("visibilitychange", onVisible)
    return () => {
      stop = true
      clearTimeout(timer.current)
      document.removeEventListener("visibilitychange", onVisible)
    }
  }, [])

  return data
}

type Picked = "agents" | "paneGit" | "sessions" | "agentMeta"

/** A slice of the store, followed at most once per `ms`: the component wakes no more often. */
export function useThrottledStore<K extends Picked>(key: K, ms: number): AppState[K] {
  const [value, setValue] = useState(() => useStore.getState()[key])
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    let last = 0
    const unsub = useStore.subscribe((state, prev) => {
      if (state[key] === prev[key] || timer) return
      timer = setTimeout(
        () => {
          timer = undefined
          last = Date.now()
          setValue(useStore.getState()[key])
        },
        Math.max(0, last + ms - Date.now()),
      )
    })
    return () => {
      unsub()
      clearTimeout(timer)
    }
  }, [key, ms])
  return value
}

/** The fleet model, following the store at most once a second (the agent graph moves per tool call). */
export function useFleetModel(): FleetRepo[] {
  const { local, mine } = useFleetData()
  const graph = useThrottledStore("agents", 1000)
  const paneGit = useThrottledStore("paneGit", 1000)
  const sessions = useThrottledStore("sessions", 1000)
  const meta = useThrottledStore("agentMeta", 1000)
  return useMemo(() => {
    const host = new Set(splitRoots(rootsOf(paneGit, sessions)).host)
    return fleetModel({
      agents: graph,
      paneGit,
      sessions,
      meta,
      local,
      mine,
      hostRoot: (root) => host.has(root),
    })
  }, [graph, paneGit, sessions, meta, local, mine])
}
