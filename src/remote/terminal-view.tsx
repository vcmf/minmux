import { useEffect, useRef, useState } from "react"
import type { Terminal } from "@xterm/xterm"
import type { HostMessage, Permission, RemotePane } from "../lib/remote-protocol"
import { fitFontSize, KEYS } from "./terminal-keys"

export interface TerminalViewProps {
  pane: RemotePane
  permission: Permission
  online: boolean
  epoch: number // bumps on every welcome: follow again
  send: (m: unknown) => boolean
  subscribe: (fn: (m: HostMessage) => void) => () => void
}

// Read-only: input goes through the message box or the keys bar, so the page never answers
// terminal queries back into the PTY.
/** A pane's terminal on the phone: what the computer shows, at its width. */
export function TerminalView({
  pane,
  permission,
  online,
  epoch,
  send,
  subscribe,
}: TerminalViewProps) {
  const box = useRef<HTMLDivElement>(null)
  const term = useRef<Terminal | null>(null)
  const size = useRef({ cols: 80, rows: 24 })
  const queue = useRef<HostMessage[]>([]) // messages that came before xterm loaded
  const [state, setState] = useState<"loading" | "live" | "gone" | "failed">("loading")

  const fit = () => {
    const t = term.current
    const el = box.current
    if (!t || !el) return
    t.options.fontSize = fitFontSize(el.clientWidth - 4, size.current.cols)
  }

  const apply = (m: HostMessage) => {
    const mine = (m.t === "tsnap" || m.t === "tout" || m.t === "tsize") && m.pane === pane.id
    if (!mine) return
    const t = term.current
    if (!t) return void queue.current.push(m)
    // In step with the output already queued: xterm's reset() and resize() act at once, while
    // writes are parsed later, so a fresh screen or a new size goes through the write queue.
    if (m.t === "tsnap") {
      if (m.gone) return setState("gone")
      size.current = { cols: m.cols, rows: m.rows }
      t.write("\x1bc", () => {
        t.resize(m.cols, m.rows)
        fit()
        t.write(m.data)
      })
      setState("live")
    } else if (m.t === "tout") t.write(m.data)
    else if (m.t === "tsize") {
      size.current = { cols: m.cols, rows: m.rows }
      t.write("", () => {
        t.resize(m.cols, m.rows)
        fit()
      })
    }
  }

  // xterm loads only when a terminal is opened (the chat view doesn't need it).
  useEffect(() => {
    let live = true
    void Promise.all([import("@xterm/xterm"), import("@xterm/xterm/css/xterm.css")]).then(
      ([{ Terminal }]) => {
        if (!live || !box.current) return
        const t = new Terminal({
          disableStdin: true,
          cursorBlink: false,
          scrollback: 2000,
          fontFamily: '"Geist Mono", ui-monospace, Menlo, monospace',
          theme: { background: "#0b0b0d", foreground: "#e8e8ea" },
        })
        t.open(box.current)
        term.current = t
        for (const m of queue.current.splice(0)) apply(m)
      },
      () => {
        queue.current = []
        if (!live) return
        setState("failed")
        send({ t: "term", pane: pane.id, on: false }) // nothing to show it on: stop the copy
      },
    )
    const onResize = () => fit()
    window.addEventListener("resize", onResize)
    return () => {
      live = false
      window.removeEventListener("resize", onResize)
      term.current?.dispose()
      term.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => subscribe(apply), [subscribe, pane.id])

  useEffect(() => {
    if (!online) return
    send({ t: "term", pane: pane.id, on: true })
    return () => void send({ t: "term", pane: pane.id, on: false })
  }, [online, epoch, pane.id, send])

  return (
    <div className="terminal-view">
      {state === "loading" && <p className="dim pad">Loading the terminal…</p>}
      {state === "gone" && <p className="warn pad">This terminal is gone on the computer.</p>}
      {state === "failed" && (
        <p className="warn pad">
          The terminal couldn&apos;t load. Check the connection and open it again.
        </p>
      )}
      <div className="term-box" ref={box} />
      {permission === "keys" && (
        <div className="keys-bar">
          {KEYS.map((k) => (
            <button
              key={k.label}
              className={k.label === "Enter" ? "enter" : ""}
              aria-label={k.aria}
              disabled={!online}
              onClick={() => send({ t: "keys", pane: pane.id, data: k.data })}
            >
              {k.short ?? k.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
