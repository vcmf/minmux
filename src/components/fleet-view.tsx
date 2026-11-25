// The Fleet tab's view (docs/design/FLEET_GRAPH.md): repos, their PRs and the agents working on
// them. Until the graph step, a plain list of what the model holds.
import { useEffect, useRef } from "react"
import { Graph } from "@phosphor-icons/react"
import { useFleetModel } from "./use-fleet-data"

export function FleetView() {
  // The keyboard comes here when the view shows (the parked terminals are inert).
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => ref.current?.focus(), [])
  const repos = useFleetModel()
  return (
    <div className="fleet-view" ref={ref} tabIndex={-1}>
      <div className="empty fleet-empty">
        <div>
          <Graph size={28} weight="duotone" />
          {repos.length === 0 ? (
            <p>No agent is working in a repo right now.</p>
          ) : (
            <ul className="fleet-list">
              {repos.map((r) => (
                <li key={r.key}>
                  {r.label}
                  {r.defaultBranch ? ` ⑂ ${r.defaultBranch}` : ""} · {r.counts.prs} PRs ·{" "}
                  {r.counts.agents} agents
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  )
}
