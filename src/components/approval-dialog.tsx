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
    const take = (l: ApprovalRequest[]) => {
      if (!live) return
      setList(l)
      for (const r of l) ipc.remoteApprovalShown(r.id) // this window shows them: no native prompt
    }
    void ipc.remoteApprovals().then(take)
    const off = ipc.onRemoteApprovals(take)
    return () => {
      live = false
      off()
    }
  }, [])
  const req = list[0]
  return req ? <Request key={req.id} req={req} /> : null
}

function Request({ req }: { req: ApprovalRequest }) {
  const choices = CHOICES[req.machine ? "machine" : "phone"]
  const [perm, setPerm] = useState<Permission>(req.machine ? "keys" : "send")
  const box = useRef<HTMLDivElement>(null)
  const denyRef = useRef<HTMLButtonElement>(null)

  const answer = (d: Permission | "deny") => {
    ipc.remoteApprove(req.id, d)
    requestAnimationFrame(focusActiveEntry)
  }

  useEffect(() => {
    denyRef.current?.focus() // Enter never lets a device in unseen
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault()
        answer("deny")
      } else if (e.key === "Tab") {
        // Modal: Tab stays inside the dialog, never out to the terminal behind.
        const els = [...(box.current?.querySelectorAll<HTMLElement>("button") ?? [])]
        if (els.length === 0) return
        e.preventDefault()
        const i = els.indexOf(document.activeElement as HTMLElement)
        els[(i + (e.shiftKey ? els.length - 1 : 1)) % els.length]?.focus()
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const what = choices.find((c) => c.p === perm)?.what ?? ""
  return (
    <div className="settings-overlay">
      <div
        ref={box}
        className="approval-dialog"
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
          <button ref={denyRef} className="btn" onClick={() => answer("deny")}>
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
