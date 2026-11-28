import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type {
  HostMessage,
  PendingState,
  Permission,
  RemotePane,
  RemotePanes,
  SessionState,
} from "../lib/remote-protocol"
import { PaneView } from "./pane-view"
import { AGENT, subline } from "./pane-lines"
import { PaneIcon } from "./pane-icon"
import { useOutbox } from "./outbox"
import { Link, type LinkState, type SocketLike } from "./connection"

async function getJson<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, { credentials: "same-origin", cache: "no-store", ...init })
  if (!r.ok) throw new Error(String(r.status))
  return (await r.json()) as T
}

const pendingId = () => new URLSearchParams(location.search).get("pending")
const PENDING_ID = /^([0-9a-f]{32}|limited|readonly)$/

/** Asks the computer for access: a POST from this page (its Origin is checked), then the
 *  approval screen with the pending id in the address (a reload keeps waiting). */
function AskButton({ label }: { label: string }) {
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState("")
  const ask = async () => {
    setBusy(true)
    try {
      const r = await getJson<{ pending?: string; error?: "limited" | "readonly" }>(
        "/api/approve",
        { method: "POST" },
      )
      location.assign(`/?pending=${r.pending ?? r.error ?? "limited"}`)
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
  const fixed = id === "limited" || id === "readonly" ? id : null
  const [s, setS] = useState<PendingState | { state: "limited" | "readonly" } | null>(
    fixed ? { state: fixed } : null,
  )
  useEffect(() => {
    if (fixed) return
    if (!PENDING_ID.test(id)) return setS({ state: "expired" })
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
      } catch (e) {
        // A 4xx means the id is gone; anything else is the machine blinking: keep asking.
        if (/^4\d\d$/.test((e as Error).message)) return live && setS({ state: "expired" })
      }
      if (live) setTimeout(() => void poll(), 1500)
    }
    void poll()
    return () => {
      live = false
    }
  }, [id, fixed, onDone])

  if (!s) return <Screen title="Asking for access…" />
  if (s.state === "pending")
    return (
      <Screen title={`Approve on ${s.machine}`} art={<PairArt />} center>
        <p className="lead">
          minmux there is asking whether to let this device in. Check it shows the same code.
        </p>
        <Code code={s.code} />
        <p className="waiting">
          <span className="dot wait" /> Waiting for your answer there
        </p>
      </Screen>
    )
  const again = <AskButton label="Ask again" />
  if (s.state === "readonly")
    return (
      <Screen title="Can't add devices">
        <p>
          The computer's device list was saved by a newer minmux. Update minmux there, then ask
          again.
        </p>
      </Screen>
    )
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
  const [permission, setPermission] = useState<Permission>("view")
  const [epoch, setEpoch] = useState(0) // bumps on each welcome (a pane screen re-watches)
  const linkRef = useRef<Link | null>(null)
  const listeners = useRef(new Set<(m: HostMessage) => void>())
  const subscribe = useCallback((fn: (m: HostMessage) => void) => {
    listeners.current.add(fn)
    return () => void listeners.current.delete(fn)
  }, [])
  const send = useCallback((m: unknown) => linkRef.current?.send(m) ?? false, [])

  useEffect(() => {
    const l = new Link({
      socket: () => new WebSocket(`ws://${location.host}/ws`) as unknown as SocketLike,
      session: () => getJson<SessionState>("/api/session"),
      onState: setLink,
      visible: () => document.visibilityState === "visible",
      onMessage: (m) => {
        if (m.t === "panes") setPanes(m.panes)
        if (m.t === "welcome") {
          setPermission(m.permission)
          setEpoch((e) => e + 1)
        }
        for (const fn of listeners.current) fn(m)
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

  // Unsent messages live here, above any pane screen (acks and resends survive going back).
  const outbox = useOutbox(send, subscribe, link.state === "open", epoch)

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
    case "disconnected":
      return (
        <Screen title="Disconnected">
          <p>{link.machine || "The computer"} ended this connection.</p>
          <button className="button" onClick={() => linkRef.current?.start()}>
            Connect again
          </button>
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
  const machine = link.state === "open" ? link.machine : ""
  return (
    <div className="app">
      {link.state === "reconnecting" && (
        <div className="banner">
          {link.unreachable
            ? "Can't reach the computer. Is it awake, with minmux running and Tailscale on?"
            : "Connection lost. Reconnecting…"}
        </div>
      )}
      {panes?.stale && (
        <div className="banner">The desktop window is closed: this list may be out of date.</div>
      )}
      <PaneList
        panes={panes}
        machine={machine}
        online={link.state === "open"}
        open={(pane, back) => (
          <PaneView
            pane={pane}
            permission={permission}
            online={link.state === "open"}
            epoch={epoch}
            send={send}
            subscribe={subscribe}
            outbox={outbox}
            onBack={back}
          />
        )}
      />
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

function PaneList({
  panes,
  machine,
  online,
  open: render,
}: {
  panes: RemotePanes | null
  machine: string
  online: boolean
  open: (pane: RemotePane, back: () => void) => React.ReactNode
}) {
  const [openId, setOpenId] = useState<string | null>(null)
  // The open pane as the latest list has it (its status moves); gone from the list: back to it.
  const open = openId && panes ? (panes.panes.find((p) => p.id === openId) ?? null) : null
  const groups = useMemo(
    () =>
      (panes?.tabs ?? [])
        .map((t) => ({ tab: t, panes: (panes?.panes ?? []).filter((p) => p.tab === t.id) }))
        .filter((g) => g.panes.length > 0),
    [panes],
  )
  const tabTitle = (id: string) => panes?.tabs.find((t) => t.id === id)?.title ?? ""

  if (open) return render(open, () => setOpenId(null))
  // A card only for a question on screen (a dialog), not the idle "waiting for your message".
  const waiting = (panes?.panes ?? []).filter((p) => p.asking && p.started)
  const count = panes?.panes.length ?? 0
  return (
    <div className="list">
      <header className="list-head">
        <div className="list-top">
          <span className="logo">minmux</span>
          <span className={`conn ${online ? "ok" : "down"}`}>
            <span className={`dot ${online ? "run" : "wait"}`} />
            {online ? "live" : "reconnecting…"}
          </span>
        </div>
        <h1 className="machine">{machine || "minmux"}</h1>
        {panes && (
          <p className="counts">
            {groups.length} {groups.length === 1 ? "tab" : "tabs"} · {count}{" "}
            {count === 1 ? "pane" : "panes"}
          </p>
        )}
      </header>

      {!panes && <p className="dim pad">Loading panes…</p>}

      {waiting.map((p) => (
        <button key={`w:${p.id}`} className="needs" onClick={() => setOpenId(p.id)}>
          <span className="needs-icon">
            <PaneIcon pane={p} />
          </span>
          <span className="names">
            <span className="name">
              {tabTitle(p.tab) || p.title} · {p.agent ? AGENT[p.agent] : "It"} is asking
            </span>
            <span className="sub">{p.detail ?? "needs your input"}</span>
          </span>
          <span className="chev" aria-hidden>
            ›
          </span>
        </button>
      ))}

      {groups.map((g) => (
        <section key={g.tab.id} className="group">
          <h2>{g.tab.title}</h2>
          <div className="card">
            {g.panes.map((p) => (
              <button
                key={p.id}
                className={`row${p.started ? "" : " unstarted"}`}
                disabled={!p.started}
                onClick={() => setOpenId(p.id)}
              >
                <PaneIcon pane={p} />
                <span className="names">
                  <span className="name">
                    {p.title}
                    {p.kind === "ssh" && <span className="badge">ssh</span>}
                  </span>
                  <span className="sub">{subline(p)}</span>
                </span>
                <span className={`word ${DOT[p.status]}`}>
                  {p.status === "waiting" ? "needs you" : p.status}
                </span>
              </button>
            ))}
          </div>
        </section>
      ))}
      {panes && count === 0 && <p className="dim pad">No terminals open.</p>}
      <footer className="list-foot">Over your tailnet · encrypted</footer>
    </div>
  )
}

/** Phone and computer, joined by dots: the first-visit screens. */
function PairArt() {
  return (
    <div className="pair-art" aria-hidden>
      <span className="pair-box">
        <svg
          width="22"
          height="22"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <rect x="7" y="2.5" width="10" height="19" rx="2.5" />
          <path d="M11 18h2" />
        </svg>
      </span>
      <span className="pair-dots">
        <span />
        <span />
        <span />
      </span>
      <span className="pair-box">
        <svg
          width="22"
          height="22"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <rect x="2.5" y="4" width="19" height="13" rx="2" />
          <path d="M8 21h8M12 17v4" />
        </svg>
      </span>
    </div>
  )
}

/** The approval code, one box per character (read out whole by screen readers). */
function Code({ code }: { code: string }) {
  return (
    <div className="code" role="img" aria-label={code}>
      {code.split("").map((ch, i) => (
        <span key={i} aria-hidden>
          {ch}
        </span>
      ))}
    </div>
  )
}

function Screen({
  title,
  art,
  center,
  children,
}: {
  title: string
  art?: React.ReactNode
  center?: boolean
  children?: React.ReactNode
}) {
  return (
    <div className="screen">
      <div className="logo">minmux</div>
      <div className={`screen-body${center ? " center" : ""}`}>
        {art}
        <h1>{title}</h1>
        {children}
      </div>
      <p className="screen-foot">Only devices on your tailnet can reach this page</p>
    </div>
  )
}
