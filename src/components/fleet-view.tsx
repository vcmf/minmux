// The Fleet tab's view (docs/design/FLEET_GRAPH.md): repos, their PRs and the agents working on
// them. Step 1 of the epic ships the tab itself; the graph lands in the next steps.
import { useEffect, useRef } from "react"
import { Graph } from "@phosphor-icons/react"

export function FleetView() {
  // The keyboard comes here when the view shows (the parked terminals are inert).
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => ref.current?.focus(), [])
  return (
    <div className="fleet-view" ref={ref} tabIndex={-1}>
      <div className="empty fleet-empty">
        <div>
          <Graph size={28} weight="duotone" />
          <p>The fleet graph shows here: your repos, their PRs and the agents working on them.</p>
        </div>
      </div>
    </div>
  )
}
