import { useEffect, useState } from "react"
import { CaretDown, CaretRight, Desktop, Terminal } from "@phosphor-icons/react"
import { ipc } from "../lib/ipc"
import { useMachines } from "../lib/machines-store"
import { machineLine, panesByTab, type MachineView } from "../lib/remote-machines"
import { useStore } from "../store"

/** The user's other minmux on the tailnet (remote control): listed while shown, panes to open. */
export function MachinesList() {
  const list = useMachines((s) => s.list)
  useEffect(() => {
    ipc.machinesList(true)
    return () => ipc.machinesList(false)
  }, [])
  if (list.length === 0) return null
  return (
    <div className="machines">
      <div className="remote-group">Machines</div>
      {list.map((m) => (
        <MachineRow key={m.key} m={m} />
      ))}
    </div>
  )
}

function MachineRow({ m }: { m: MachineView }) {
  const [open, setOpen] = useState(true)
  const line = machineLine(m)
  const ask = m.state === "new" || m.state === "denied" || m.state === "locked"
  const live = m.state === "connected"
  return (
    <div className="machine">
      <div className="tree-row remote-row machine-row" style={{ paddingLeft: 12 }}>
        <button
          className="remote-open"
          onClick={() => live && setOpen(!open)}
          aria-expanded={live ? open : undefined}
          title={m.key}
        >
          <span className="tree-icon">
            {live ? (
              open ? (
                <CaretDown size={11} />
              ) : (
                <CaretRight size={11} />
              )
            ) : (
              <Desktop size={14} color="var(--dim)" />
            )}
          </span>
          <span className="tree-labels">
            <span className="tree-primary">{m.label}</span>
            {line && <span className="tree-sub">{line}</span>}
          </span>
        </button>
        {ask && (
          <button className="remote-empty-btn machine-ask" onClick={() => ipc.machinesPair(m.key)}>
            {m.state === "new" ? "Ask for access" : "Ask again"}
          </button>
        )}
        {live && <span className="dot accent" title="Connected" />}
      </div>
      {live && open && m.panes && <MachinePanes m={m} />}
    </div>
  )
}

function MachinePanes({ m }: { m: MachineView }) {
  const groups = panesByTab(m.panes!)
  if (groups.length === 0) return <div className="remote-group machine-empty">No panes open</div>
  return (
    <>
      {groups.map((g) => (
        <div key={g.id}>
          {groups.length > 1 && (
            <div className="remote-group machine-tab" style={{ paddingLeft: 30 }}>
              {g.title}
            </div>
          )}
          {g.panes.map((p) => (
            <button
              key={p.id}
              className="tree-row remote-row machine-pane"
              style={{ paddingLeft: 30 }}
              disabled={!p.started}
              title={p.started ? `Open in this pane` : "Not started on that computer yet"}
              onClick={() =>
                useStore
                  .getState()
                  .openPeer({ key: m.key, pane: p.id, machine: m.label }, p.title || "terminal")
              }
            >
              <span className="tree-icon">
                <Terminal
                  size={13}
                  color={p.status === "waiting" ? "var(--amber)" : "var(--dim)"}
                />
              </span>
              <span className="tree-labels">
                <span className="tree-primary">{p.title || "terminal"}</span>
                {p.cwd && <span className="tree-sub">{p.cwd}</span>}
              </span>
              {p.status === "working" && <span className="dot accent pulse" />}
              {p.status === "waiting" && <span className="dot amber" />}
            </button>
          ))}
        </div>
      ))}
    </>
  )
}
