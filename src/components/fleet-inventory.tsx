// The Fleet inventory (docs/design/FLEET_GRAPH.md, step 6): one column per agent kind, its MCP
// servers and skills with their use counts over a window, then the loaded but unused ones.
// Live adds up the open sessions; the other windows ask main's history scan (in the sessions
// worker, cached on disk). A used row picks the open sessions that used it, for the graph.
import { useEffect, useRef, useState } from "react"
import type { AgentKind } from "../lib/agent-graph"
import { AVAILABLE_AGENTS, agentColor, agentInfo } from "../lib/agent-kinds"
import {
  liveToolbox,
  windowToolbox,
  usedBy,
  type Inventory,
  type InventoryWindow,
} from "../lib/fleet-inventory"
import type { FleetAgent } from "../lib/fleet-model"
import { mcpList, skillList, type ToolList } from "../lib/fleet-toolbox"
import { ipc } from "../lib/ipc"
import { useStore, activeTheme } from "../store"
import { agentIcon } from "./agent-icon"

const WINDOWS: { id: InventoryWindow; label: string }[] = [
  { id: "live", label: "Live" },
  { id: "7d", label: "7 days" },
  { id: "30d", label: "30 days" },
  { id: "all", label: "All" },
]

/** The history: asked for when a window is shown, again when one is chosen a while later. */
function useHistory(
  want: boolean,
  win: InventoryWindow,
): {
  inv: Inventory | null
  state: "idle" | "loading" | "failed"
  retry: () => void
} {
  const [inv, setInv] = useState<Inventory | null>(null)
  const [state, setState] = useState<"idle" | "loading" | "failed">("idle")
  const [attempt, setAttempt] = useState(0)
  const fetched = useRef(0)
  const tried = useRef(0)
  useEffect(() => {
    // (main reuses a scan for 30 s: sooner than that, the answer would be the same; a retry
    // always asks)
    const retrying = attempt !== tried.current
    tried.current = attempt
    if (!want || (inv && !retrying && Date.now() - fetched.current < 30_000)) return
    let live = true
    setState("loading") // (the numbers shown stay until the new ones come)
    ipc.fleetInventory().then(
      (v) => {
        if (!live) return
        if (v) {
          fetched.current = Date.now()
          setInv(v)
        }
        setState(v ? "idle" : "failed")
      },
      () => live && setState("failed"),
    )
    return () => {
      live = false
      setState((s) => (s === "loading" ? "idle" : s)) // (cancelled: nothing is loading now)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `inv` read, not watched
  }, [want, win, attempt])
  return { inv, state, retry: () => setAttempt((n) => n + 1) }
}

export function FleetInventory(props: {
  shown: boolean // (kept mounted while the graph shows: it reads and renders nothing then)
  agents: FleetAgent[]
  onPick: (ids: string[], label: string) => void
}) {
  const [win, setWin] = useState<InventoryWindow>("live")
  const { inv, state, retry } = useHistory(props.shown && win !== "live", win)
  if (!props.shown) return null
  const today = new Date() // (each render: a view left open over midnight moves on)
  return (
    <div className="fleet-inventory">
      <div className="fleet-windows" role="group" aria-label="Window">
        {WINDOWS.map((w) => (
          <button
            key={w.id}
            className={`fleet-window${win === w.id ? " on" : ""}`}
            aria-pressed={win === w.id}
            onClick={() => {
              setWin(w.id)
              if (state === "failed") retry() // (a window chosen again tries again)
            }}
          >
            {w.label}
          </button>
        ))}
        {win !== "live" && state === "loading" && (
          <span className="faint">reading history… (the first time reads all of it)</span>
        )}
        {win !== "live" && state === "failed" && (
          <span className="faint">history can't be read right now</span>
        )}
      </div>
      <div className="fleet-columns">
        {AVAILABLE_AGENTS.map((kind) => {
          const tb =
            win === "live"
              ? liveToolbox(props.agents, kind)
              : inv?.[kind]
                ? windowToolbox(inv[kind]!, win, today)
                : undefined
          return (
            <InventoryColumn
              key={kind}
              kind={kind}
              mcp={tb && mcpList(tb)}
              skills={tb ? skillList(tb) : undefined}
              pending={win !== "live" && !inv && state === "loading"}
              failed={win !== "live" && !inv && state === "failed"}
              live={win === "live"}
              onPick={(what, name) =>
                props.onPick(
                  usedBy(props.agents, kind, what, name),
                  `${agentInfo(kind).label} · ${name}`,
                )
              }
              canPick={(what, name) => usedBy(props.agents, kind, what, name).length > 0}
            />
          )
        })}
      </div>
    </div>
  )
}

function InventoryColumn(props: {
  kind: AgentKind
  mcp: ToolList | undefined
  skills: ToolList | null | undefined
  pending: boolean
  failed: boolean
  live: boolean
  onPick: (what: "mcp" | "skill", name: string) => void
  canPick: (what: "mcp" | "skill", name: string) => boolean
}) {
  const scheme = useStore((s) => activeTheme(s).scheme)
  const Icon = agentIcon(props.kind)
  return (
    <section className="fleet-column" aria-label={agentInfo(props.kind).label}>
      <h2>
        <Icon size={15} color={agentColor(props.kind, scheme)} /> {agentInfo(props.kind).label}
      </h2>
      <Rows
        title="MCP servers"
        list={props.mcp}
        unit="call"
        empty={
          props.pending ? "…" : props.failed ? "—" : props.live ? "no open session" : "none seen"
        }
        onPick={(n) => props.onPick("mcp", n)}
        canPick={(n) => props.canPick("mcp", n)}
      />
      <Rows
        title="Skills"
        list={props.skills}
        unit="use"
        unsupported={props.skills === null}
        empty={
          props.pending ? "…" : props.failed ? "—" : props.live ? "no open session" : "none seen"
        }
        onPick={(n) => props.onPick("skill", n)}
        canPick={(n) => props.canPick("skill", n)}
      />
    </section>
  )
}

const UNUSED_SHOWN = 8

function Rows(props: {
  title: string
  list: ToolList | null | undefined
  unit: string
  unsupported?: boolean
  empty: string
  onPick: (name: string) => void
  canPick: (name: string) => boolean
}) {
  const [more, setMore] = useState(false)
  const { list } = props
  const used = list?.used.filter((r) => r.uses > 0).length ?? 0
  const unused = list?.unused ?? []
  const shown = more ? unused : unused.slice(0, UNUSED_SHOWN)
  return (
    <>
      <h3 className="fleet-tools-head">
        {props.title}
        {list && !!list.total && (
          <span className="faint">
            used {used} / {list.total}
          </span>
        )}
      </h3>
      {props.unsupported ? (
        <div className="faint">not supported yet</div>
      ) : !list || (!list.used.length && !unused.length) ? (
        <div className="faint">{props.empty}</div>
      ) : (
        <ul className="fleet-rows">
          {list.used.map((r) => {
            const pick = props.canPick(r.name)
            return (
              <li key={r.name}>
                <button
                  className={`fleet-row${r.down || (r.failed && !r.uses) ? " bad" : ""}`}
                  disabled={!pick}
                  title={pick ? "Show the open sessions that used it" : "No open session used it"}
                  onClick={() => props.onPick(r.name)}
                >
                  <span className="one">{r.name}</span>
                  <span className="faint">
                    {r.down
                      ? "failed to start"
                      : `${r.uses} ${props.unit}${r.uses === 1 ? "" : "s"}${r.failed ? ` · ${r.failed} failed` : ""}`}
                  </span>
                </button>
              </li>
            )
          })}
          {shown.map((n) => (
            <li key={n} className="fleet-row unused">
              <span className="one">{n}</span>
              <span className="faint">unused</span>
            </li>
          ))}
          {unused.length > UNUSED_SHOWN && (
            <li>
              <button className="fleet-more" onClick={() => setMore((m) => !m)}>
                {more ? "fewer" : `+${unused.length - UNUSED_SHOWN} more unused`}
              </button>
            </li>
          )}
        </ul>
      )}
    </>
  )
}
