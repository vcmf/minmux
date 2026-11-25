// The fleet's data beyond the store (docs/design/FLEET_GRAPH.md, "Data"): each repo's GitHub
// name, worktrees and default branch (prs:local), and my open PRs (the lists' `mine`). Asked
// only while the Fleet tab is mounted and the window is visible, at the PR dialog's cadence.
import { useEffect, useMemo, useRef, useState } from "react"
import { useStore } from "../store"
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

/** The panes' host checkout roots (WSL and ssh panes left out, as the PR dialog does). */
const hostRoots = () => {
  const s = useStore.getState()
  return splitRoots(rootsOf(s.paneGit, s.sessions)).host
}

async function askLocal(roots: string[]): Promise<boolean> {
  if (!roots.length) return false
  const r = await ipc.prLocal({ roots }).catch(() => null)
  if (!r?.ok) return false
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

  // Repos, as soon as the set of roots changes (main caches names; worktrees are re-read).
  useEffect(() => {
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
      if (document.visibilityState !== "hidden" && due() <= 0) void tick()
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

/** `value`, updated at most once per `ms` (the latest one at the end of each window). */
export function useThrottled<T>(value: T, ms: number): T {
  const [shown, setShown] = useState(value)
  const last = useRef(0)
  const latest = useRef(value)
  latest.current = value
  useEffect(() => {
    if (value === shown) return
    const wait = last.current + ms - Date.now()
    const t = setTimeout(
      () => {
        last.current = Date.now()
        setShown(latest.current)
      },
      Math.max(0, wait),
    )
    return () => clearTimeout(t)
  }, [value, shown, ms])
  return shown
}

/** The fleet model, following the store at most once a second (the agent graph moves per tool call). */
export function useFleetModel(): FleetRepo[] {
  const { local, mine } = useFleetData()
  const graph = useThrottled(
    useStore((s) => s.agents),
    1000,
  )
  const paneGit = useThrottled(
    useStore((s) => s.paneGit),
    1000,
  )
  const sessions = useThrottled(
    useStore((s) => s.sessions),
    1000,
  )
  const meta = useStore((s) => s.agentMeta)
  return useMemo(
    () => fleetModel({ agents: graph, paneGit, sessions, meta, local, mine }),
    [graph, paneGit, sessions, meta, local, mine],
  )
}
