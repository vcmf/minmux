// The fleet's data beyond the store (docs/design/FLEET_GRAPH.md, "Data"): each repo's GitHub
// name and default branch (prs:local), and my open PRs (the lists' `mine`). Asked only while
// the Fleet tab is mounted and the window is visible, at the PR dialog's cadence.
import { useEffect, useMemo, useRef, useState } from "react"
import { useShallow } from "zustand/react/shallow"
import { useStore } from "../store"
import { ipc } from "../lib/ipc"
import { fleetModel, type FleetRepo } from "../lib/fleet-model"
import { nextRefreshMs, type PrLists, type PrRow } from "../lib/pr-dashboard"
import type { LocalRepo } from "../lib/pr-local"

interface FleetData {
  local: LocalRepo[]
  mine: PrRow[]
}

// The last answers, kept across mounts: reopening the tab shows them at once.
let cache: FleetData = { local: [], mine: [] }
let lastLists: PrLists | null = null

/** The checkout roots the panes are in, sorted (a stable key for the repos request). */
const rootsOf = (paneGit: Record<string, { root?: string }>) =>
  [...new Set(Object.values(paneGit).flatMap((g) => (g.root ? [g.root] : [])))].sort()

export function useFleetData(): FleetData {
  const [data, setData] = useState(cache)
  const roots = useStore(useShallow((s) => rootsOf(s.paneGit)))
  const rootsKey = roots.join("\0")
  const failures = useRef(0)

  // Repos: again whenever the set of roots changes (one `worktree list` per repo; cached names).
  useEffect(() => {
    if (!roots.length) return
    let stale = false
    void ipc
      .prLocal({ roots })
      .then((r) => {
        if (stale || !r.ok) return
        cache = { ...cache, local: r.repos }
        setData(cache)
      })
      .catch(() => {})
    return () => {
      stale = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- rootsKey stands for roots
  }, [rootsKey])

  // My open PRs: at once, then by the dialog's cadence (slower on failures or a low budget).
  useEffect(() => {
    let stop = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const loop = async () => {
      if (document.visibilityState !== "hidden") {
        const r = await ipc.prLists({ closed: false, part: "mine" }).catch(() => null)
        if (stop) return
        if (r?.ok) {
          failures.current = 0
          lastLists = r.lists
          cache = { ...cache, mine: r.lists.mine }
          setData(cache)
        } else failures.current++
      }
      if (!stop) timer = setTimeout(() => void loop(), nextRefreshMs(lastLists, failures.current))
    }
    void loop()
    return () => {
      stop = true
      clearTimeout(timer)
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

/** The fleet model, following the agent graph at most once a second (it moves per tool call). */
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
