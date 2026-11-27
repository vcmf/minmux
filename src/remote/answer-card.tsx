import { useEffect, useState } from "react"
import type { AnswerRefusal, Dialog, HostMessage, RemotePane } from "../lib/remote-protocol"

const REASON: Record<AnswerRefusal, string> = {
  "not-allowed": "This device can only view. Change it in minmux's Settings.",
  stale: "That question was already answered.",
  changed: "The screen changed. Look again before answering.",
  unsupported: "Answer it in the Terminal view.",
  error: "Couldn't answer.",
}

interface Props {
  pane: RemotePane
  agentName: string
  canAnswer: boolean // the device may send
  send: (m: unknown) => boolean
  subscribe: (fn: (m: HostMessage) => void) => () => void
  openTerminal: () => void
}

/** The agent's open question, as its screen shows it, with a button per option. */
export function AnswerCard({ pane, agentName, canAnswer, send, subscribe, openTerminal }: Props) {
  const [dialog, setDialog] = useState<{ d: Dialog | null; answerable: boolean } | null>(null)
  const [busy, setBusy] = useState<number | null>(null)
  const [note, setNote] = useState("")
  const waitId = pane.waitId ?? ""

  useEffect(
    () =>
      subscribe((m) => {
        if (m.t === "dialog" && m.pane === pane.id)
          setDialog({ d: m.dialog, answerable: m.answerable })
        if (m.t === "answered" && m.pane === pane.id && m.waitId === waitId) {
          setBusy(null)
          if (!m.ok) setNote(m.reason ? REASON[m.reason] : REASON.error)
        }
      }),
    [subscribe, pane.id, waitId],
  )

  // Read the screen when the question appears (or another one replaces it).
  useEffect(() => {
    setDialog(null)
    setNote("")
    send({ t: "dialog", pane: pane.id })
  }, [send, pane.id, waitId])

  const answer = (n: number, label: string) => {
    setBusy(n)
    setNote("")
    send({ t: "answer", pane: pane.id, waitId, n, label })
  }

  return (
    <div className="asking">
      <b>{agentName} is asking:</b> {dialog?.d ? dialog.d.question : (pane.detail ?? "a question")}
      {dialog?.d && (
        <div className="answer-options">
          {dialog.d.options.map((o) =>
            dialog.answerable && canAnswer ? (
              <button key={o.n} disabled={busy !== null} onClick={() => answer(o.n, o.label)}>
                <span className="answer-n">{o.n}</span> {o.label}
                {busy === o.n && " …"}
              </button>
            ) : (
              <div key={o.n} className="answer-option">
                <span className="answer-n">{o.n}</span> {o.label}
              </div>
            ),
          )}
        </div>
      )}
      {dialog && (!dialog.d || !dialog.answerable) && (
        <div className="answer-foot">
          {dialog.d
            ? "Answer it in the Terminal view, with the keys bar."
            : "Its options aren't on screen."}{" "}
          <button className="link" onClick={openTerminal}>
            Open the Terminal view
          </button>
        </div>
      )}
      {note && <div className="answer-note">{note}</div>}
      <button className="link" onClick={() => send({ t: "dialog", pane: pane.id })}>
        Look again
      </button>
    </div>
  )
}
