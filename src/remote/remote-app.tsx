import { useEffect, useMemo, useRef, useState } from "react"
import type { PendingState, RemotePane, RemotePanes, SessionState } from "../lib/remote-protocol"
import { Link, type LinkState, type SocketLike } from "./connection"

async function getJson<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, { credentials: "same-origin", cache: "no-store", ...init })
  if (!r.ok) throw new Error(String(r.status))
  return (await r.json()) as T
}

const pendingId = () => new URLSearchParams(location.search).get("pending")

/** Asks the computer for access: a POST from this page (its Origin is checked), then the
 *  approval screen with the pending id in the address (a reload keeps waiting). */
function AskButton({ label }: { label: string }) {
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState("")
  const ask = async () => {
    setBusy(true)
    try {
      const r = await getJson<{ pending: string | null }>("/api/approve", { method: "POST" })
      location.assign(`/?pending=${r.pending ?? "limited"}`)
    } catch {
      setNote("Can't reach the computer.")
      setBusy(false)
    }
  }
  return (
    <>
      <button className="button" disabled={busy} onClick={() => void ask()}>
        {label}
      </button>
      {note && <p className="warn">{note}</p>}
    </>
  )
}

/** The phone's web app: access, PIN, then the pane list. */
export function RemoteApp() {
  const [pending, setPending] = useState<string | null>(pendingId)
  if (pending) return <Approval id={pending} onDone={() => setPending(null)} />
  return <Connected />
}

/** Waiting for the desktop's approval, showing the code it shows. */
function Approval({ id, onDone }: { id: string; onDone: () => void }) {
  const [s, setS] = useState<PendingState | { state: "limited" } | null>(
    id === "limited" ? { state: "limited" } : null,
  )
  useEffect(() => {
    if (id === "limited") return
    let live = true
    const poll = async () => {
      try {
        const r = await getJson<PendingState>(`/api/pending/${id}`)
        if (!live) return
        setS(r)
        if (r.state === "approved") {
          history.replaceState(null, "", "/")
          onDone()
          return
        }
        if (r.state !== "pending") return
      } catch {
        // the machine blinked: keep asking
      }
      if (live) setTimeout(() => void poll(), 1500)
    }
    void poll()
    return () => {
      live = false
    }
  }, [id, onDone])

  if (!s) return <Screen title="Asking for access…" />
  if (s.state === "pending")
    return (
      <Screen title={`Approve on ${s.machine}`}>
        <p>{s.machine} is asking whether to let this device in. Check that it shows this code:</p>
        <div className="code">{s.code}</div>
        <p className="dim">Waiting for your answer there…</p>
      </Screen>
    )
  const again = <AskButton label="Ask again" />
  if (s.state === "limited")
    return (
      <Screen title="Too many requests">
        <p>Wait a few minutes, then ask again.</p>
        {again}
      </Screen>
    )
  if (s.state === "denied")
    return (
      <Screen title="Not allowed">
        <p>The request was denied on the computer.</p>
        {again}
      </Screen>
    )
  return (
    <Screen title="The request expired">
      <p>It wasn't answered in 2 minutes.</p>
      {again}
    </Screen>
  )
}

/** Connected (or trying to be): the pane list, or why not. */
function Connected() {
  const [link, setLink] = useState<LinkState>({ state: "connecting" })
  const [panes, setPanes] = useState<RemotePanes | null>(null)
  const linkRef = useRef<Link | null>(null)

  useEffect(() => {
    const l = new Link({
      socket: () => new WebSocket(`ws://${location.host}/ws`) as unknown as SocketLike,
      session: () => getJson<SessionState>("/api/session"),
      onState: setLink,
      onMessage: (m) => {
        if (m.t === "panes") setPanes(m.panes)
      },
    })
    linkRef.current = l
    l.start()
    const wake = () => document.visibilityState === "visible" && l.wake()
    document.addEventListener("visibilitychange", wake)
    window.addEventListener("online", wake)
    window.addEventListener("pageshow", wake)
    return () => {
      document.removeEventListener("visibilitychange", wake)
      window.removeEventListener("online", wake)
      window.removeEventListener("pageshow", wake)
      l.stop()
    }
  }, [])

  switch (link.state) {
    case "no-access":
      return (
        <Screen title={`Use ${link.machine} from here`}>
          <p>This device isn't approved yet. {link.machine} will ask you to allow it.</p>
          <AskButton label="Ask for access" />
        </Screen>
      )
    case "locked":
      return <Locked state={link} onUnlocked={() => linkRef.current?.start()} />
    case "removed":
      return (
        <Screen title="This device was removed">
          <p>It was removed in minmux's settings.</p>
          <AskButton label="Ask for access again" />
        </Screen>
      )
    case "version":
      return (
        <Screen title="minmux was updated">
          <button className="button" onClick={() => location.reload()}>
            Reload
          </button>
        </Screen>
      )
  }
  const reconnecting = link.state === "reconnecting" || link.state === "connecting"
  return (
    <div className="app">
      <header className="bar">
        <span className="machine">{link.state === "open" ? link.machine : "minmux"}</span>
        <span className={`conn ${link.state === "open" ? "ok" : "down"}`}>
          {link.state === "open" ? "connected" : "reconnecting…"}
        </span>
      </header>
      {reconnecting && link.state === "reconnecting" && (
        <div className="banner">
          {link.unreachable
            ? "Can't reach the computer. Is it awake, with minmux running and Tailscale on?"
            : "Connection lost. Reconnecting…"}
        </div>
      )}
      {panes?.stale && (
        <div className="banner">The desktop window is closed: this list may be out of date.</div>
      )}
      {panes ? <PaneList panes={panes} /> : <p className="dim pad">Loading panes…</p>}
    </div>
  )
}

/** Locked after 24 h without use: the PIN set on the computer lifts it. */
function Locked({
  state,
  onUnlocked,
}: {
  state: Extract<LinkState, { state: "locked" }>
  onUnlocked: () => void
}) {
  const [pin, setPin] = useState("")
  const [note, setNote] = useState("")
  const [busy, setBusy] = useState(false)
  if (!state.pin)
    return (
      <Screen title="Locked">
        <p>This device wasn't used for 24 hours. Approve it again on {state.machine}.</p>
        <AskButton label="Ask for access" />
      </Screen>
    )
  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    try {
      const r = await getJson<{ result: string }>("/api/unlock", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pin }),
      })
      setPin("")
      if (r.result === "ok") return onUnlocked()
      if (r.result === "wrong") setNote("Wrong PIN.")
      else if (r.result === "blocked")
        setNote("Too many wrong PINs: this device was removed. Ask for access again.")
      else if (r.result === "disabled")
        setNote(
          `Unlocking by PIN is off after too many wrong PINs. Set a new PIN on ${state.machine}.`,
        )
      else onUnlocked() // the state changed: check again
    } catch {
      setNote("Can't reach the computer.")
    } finally {
      setBusy(false)
    }
  }
  return (
    <Screen title="Locked">
      <p>
        {state.device} wasn't used for 24 hours. Enter the PIN you set in minmux on {state.machine}.
      </p>
      <form onSubmit={(e) => void submit(e)} className="pin">
        <input
          type="password"
          inputMode="numeric"
          autoComplete="current-password"
          value={pin}
          onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 32))}
          aria-label="PIN"
        />
        <button className="button" disabled={busy || pin.length < 6}>
          Unlock
        </button>
      </form>
      {note && <p className="warn">{note}</p>}
    </Screen>
  )
}

const DOT: Record<RemotePane["status"], string> = { working: "run", waiting: "wait", idle: "idle" }
const WORD: Record<RemotePane["status"], string> = {
  working: "working",
  waiting: "needs input",
  idle: "idle",
}

function PaneList({ panes }: { panes: RemotePanes }) {
  const [waitingFirst, setWaitingFirst] = useState(false)
  const [open, setOpen] = useState<RemotePane | null>(null)
  const groups = useMemo(() => {
    const byTab = panes.tabs.map((t) => ({
      tab: t,
      panes: panes.panes.filter((p) => p.tab === t.id),
    }))
    if (!waitingFirst) return byTab
    const waiting = panes.panes.filter((p) => p.status === "waiting")
    return [{ tab: { id: "waiting", title: "Needs input" }, panes: waiting }, ...byTab]
  }, [panes, waitingFirst])
  const waitingCount = panes.panes.filter((p) => p.status === "waiting").length

  if (open)
    return (
      <div className="pane-view">
        <button className="back" onClick={() => setOpen(null)}>
          ‹ Panes
        </button>
        <h2>{open.title}</h2>
        <p className="dim">Reading and sending to a pane comes in the next update.</p>
      </div>
    )
  return (
    <div className="list">
      <label className="toggle">
        <input
          type="checkbox"
          checked={waitingFirst}
          onChange={(e) => setWaitingFirst(e.target.checked)}
        />
        Needs input first {waitingCount > 0 && <span className="count">{waitingCount}</span>}
      </label>
      {groups.map(
        (g) =>
          g.panes.length > 0 && (
            <section key={g.tab.id}>
              <h3>{g.tab.title}</h3>
              {g.panes.map((p) => (
                <button
                  key={`${g.tab.id}:${p.id}`}
                  className={`row${p.started ? "" : " unstarted"}`}
                  disabled={!p.started}
                  onClick={() => setOpen(p)}
                >
                  <span className={`dot ${DOT[p.status]}`} />
                  <span className="names">
                    <span className="name">
                      {p.title}
                      {p.agent && <span className="badge">{p.agent}</span>}
                      {p.kind === "ssh" && <span className="badge">ssh</span>}
                    </span>
                    <span className="sub">
                      {!p.started
                        ? "not started on the desktop"
                        : p.status === "waiting" && p.detail
                          ? p.detail
                          : (p.cwd ?? "")}
                    </span>
                  </span>
                  <span className={`word ${DOT[p.status]}`}>{WORD[p.status]}</span>
                </button>
              ))}
            </section>
          ),
      )}
      {panes.panes.length === 0 && <p className="dim pad">No terminals open.</p>}
    </div>
  )
}

function Screen({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div className="screen">
      <div className="logo">minmux</div>
      <h1>{title}</h1>
      {children}
    </div>
  )
}
