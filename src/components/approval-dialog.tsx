import { useEffect, useRef, useState } from "react"
import { Desktop, DeviceMobile } from "@phosphor-icons/react"
import { ipc } from "../lib/ipc"
import type { Permission } from "../lib/remote-protocol"
import type { ApprovalRequest } from "../lib/remote-view"
import { focusActiveEntry } from "./refocus-terminal"

const CHOICES: Record<"phone" | "machine", { p: Permission; label: string; what: string }[]> = {
  phone: [
    { p: "view", label: "Watch", what: "Read every pane. Nothing it does reaches them." },
    {
      p: "send",
      label: "Send",
      what: "Read every pane, send messages to agents between turns, answer their questions.",
    },
    {
      p: "keys",
      label: "Type keys",
      what: "All of that, and type into terminals as if at this keyboard.",
    },
  ],
  machine: [
    { p: "view", label: "Watch", what: "See your panes from there. Nothing it does reaches them." },
    {
      p: "keys",
      label: "Type keys",
      what: "See your panes and type in them, as if at this keyboard.",
    },
  ],
}

/** A device (or minmux on another machine) asks to use this one: allow it, and how far. */
export function ApprovalDialog() {
  const [list, setList] = useState<ApprovalRequest[]>([])
  useEffect(() => {
    let live = true
    let pushed = false // main's pushes are newer than the first fetch's reply
    const take = (l: ApprovalRequest[]) => {
      if (!live) return
      setList(l)
      for (const r of l) ipc.remoteApprovalShown(r.id) // this window shows them: no native prompt
    }
    void ipc.remoteApprovals().then((l) => !pushed && take(l))
    const off = ipc.onRemoteApprovals((l) => {
      pushed = true
      take(l)
    })
    return () => {
      live = false
      off()
    }
  }, [])
  // However the last request goes (answered, expired, answered natively), the keyboard goes back
  // to the active terminal if it was left nowhere; never while another request still shows.
  const wasOpen = useRef(false)
  useEffect(() => {
    if (list.length) wasOpen.current = true
    else if (wasOpen.current) {
      wasOpen.current = false
      requestAnimationFrame(() => {
        const a = document.activeElement
        if (!document.querySelector(".approval-dialog") && (!a || a === document.body))
          focusActiveEntry()
      })
    }
  }, [list])
  const req = list[0]
  return req ? <Request key={req.id} req={req} /> : null
}

function Request({ req }: { req: ApprovalRequest }) {
  const choices = CHOICES[req.machine ? "machine" : "phone"]
  const [perm, setPerm] = useState<Permission>(req.machine ? "keys" : "send")
  const box = useRef<HTMLDivElement>(null)

  const answer = (d: Permission | "deny") => ipc.remoteApprove(req.id, d)

  useEffect(() => {
    // The dialog itself takes focus, not a button: a request can arrive mid-typing, and a
    // Space or Enter meant for the terminal must not answer it unread.
    box.current?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" && e.key !== "Tab") return
      // Capture phase, and only this listener: the topmost modal owns these keys.
      e.preventDefault()
      e.stopImmediatePropagation()
      if (e.key === "Escape") return answer("deny")
      // Modal: Tab stays inside the dialog, never out to the terminal behind.
      const els = [...(box.current?.querySelectorAll<HTMLElement>("button") ?? [])]
      const i = els.indexOf(document.activeElement as HTMLElement)
      const next = i < 0 ? (e.shiftKey ? els.length - 1 : 0) : i + (e.shiftKey ? -1 : 1)
      els[(next + els.length) % els.length]?.focus()
    }
    window.addEventListener("keydown", onKey, true)
    return () => window.removeEventListener("keydown", onKey, true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const what = choices.find((c) => c.p === perm)?.what ?? ""
  return (
    <div className="settings-overlay">
      <div
        ref={box}
        className="approval-dialog"
        tabIndex={-1}
        role="alertdialog"
        aria-labelledby="approval-title"
        aria-describedby="approval-code-note"
      >
        <div className="approval-head">
          <span className="approval-icon" aria-hidden>
            {req.machine ? <Desktop size={20} /> : <DeviceMobile size={20} />}
          </span>
          <div className="approval-names">
            <h2 id="approval-title">
              {req.machine
                ? `minmux on ${req.name} wants to open your terminals`
                : `${req.name} wants to use minmux`}
            </h2>
            <span className="approval-sub">on your tailnet</span>
          </div>
        </div>

        <div className="approval-block">
          <span id="approval-code-note" className="approval-label">
            Allow it only if {req.machine ? req.name : "the device"} shows this code
          </span>
          <div className="approval-code" aria-label={`Code ${req.code.split("").join(" ")}`}>
            {req.code.split("").map((ch, i) => (
              <span key={i} aria-hidden>
                {ch}
              </span>
            ))}
          </div>
        </div>

        <div className="approval-block">
          <span className="approval-label" id="approval-perm">
            It can
          </span>
          <div className="approval-perm" role="radiogroup" aria-labelledby="approval-perm">
            {choices.map((c) => (
              <button
                key={c.p}
                role="radio"
                aria-checked={perm === c.p}
                className={perm === c.p ? "on" : ""}
                onClick={() => setPerm(c.p)}
              >
                {c.label}
              </button>
            ))}
          </div>
          <p className="approval-what">{what}</p>
        </div>

        <div className="confirm-actions">
          <button className="btn" onClick={() => answer("deny")}>
            Deny
          </button>
          <button className="btn primary" onClick={() => answer(perm)}>
            Allow
          </button>
        </div>
      </div>
    </div>
  )
}
