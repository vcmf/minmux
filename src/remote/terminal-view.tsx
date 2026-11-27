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

/** A pane's terminal on the phone: what the computer shows, at its width, read-only (input goes
 *  through the message box or the keys bar, so the page never answers terminal queries). */
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
  const [state, setState] = useState<"loading" | "live" | "gone">("loading")

  const fit = () => {
    const t = term.current
    const el = box.current
    if (!t || !el) return
    t.options.fontSize = fitFontSize(el.clientWidth - 4, size.current.cols)
  }

  const apply = (m: HostMessage) => {
    const t = term.current
    if (!t) return void queue.current.push(m)
    if (m.t === "tsnap" && m.pane === pane.id) {
      if (m.gone) return setState("gone")
      size.current = { cols: m.cols, rows: m.rows }
      t.reset()
      t.resize(m.cols, m.rows)
      fit()
      t.write(m.data)
      setState("live")
    } else if (m.t === "tout" && m.pane === pane.id) t.write(m.data)
    else if (m.t === "tsize" && m.pane === pane.id) {
      size.current = { cols: m.cols, rows: m.rows }
      t.resize(m.cols, m.rows)
      fit()
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
      <div className="term-box" ref={box} />
      {permission === "keys" && (
        <div className="keys-bar">
          {KEYS.map((k) => (
            <button
              key={k.label}
              disabled={!online}
              onClick={() => send({ t: "keys", pane: pane.id, data: k.data })}
            >
              {k.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
