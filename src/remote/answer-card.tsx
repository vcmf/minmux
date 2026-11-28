import { useEffect, useState } from "react"
import {
  dialogSignature,
  type AnswerRefusal,
  type Dialog,
  type HostMessage,
  type RemotePane,
} from "../lib/remote-protocol"

const REASON: Record<AnswerRefusal, string> = {
  "not-allowed": "This device can only view. Change it in minmux's Settings.",
  stale: "That question was already answered.",
  changed: "The screen changed. Look again before answering.",
  unsupported: "Answer it in the Terminal view.",
  "no-window": "The computer's minmux window is closed: answers need it open to check the screen.",
  error: "Couldn't answer.",
}

interface Props {
  pane: RemotePane
  agentName: string
  canAnswer: boolean // the device may send
  keysAllowed: boolean // …and type raw keys (the Terminal view's keys bar)
  online: boolean
  epoch: number // bumps on every welcome: read the screen again
  send: (m: unknown) => boolean
  subscribe: (fn: (m: HostMessage) => void) => () => void
  openTerminal: () => void
}

/** The agent's open question, as its screen shows it, with a button per option. */
export function AnswerCard({
  pane,
  agentName,
  canAnswer,
  keysAllowed,
  online,
  epoch,
  send,
  subscribe,
  openTerminal,
}: Props) {
  const [dialog, setDialog] = useState<{ d: Dialog | null; answerable: boolean } | null>(null)
  const [busy, setBusy] = useState<number | null>(null)
  const [note, setNote] = useState("")
  const waitId = pane.waitId ?? ""

  useEffect(
    () =>
      subscribe((m) => {
        // Only the reply about this dialog: one about an earlier one (still on its way) is dropped.
        if (m.t === "dialog" && m.pane === pane.id && m.waitId === waitId)
          setDialog({ d: m.dialog, answerable: m.answerable })
        if (m.t === "error") setBusy(null) // a refused request: never leave the buttons stuck
        if (m.t === "answered" && m.pane === pane.id && m.waitId === waitId) {
          setBusy(null)
          if (!m.ok) setNote(m.reason ? REASON[m.reason] : REASON.error)
        }
      }),
    [subscribe, pane.id, waitId],
  )

  // Read the screen when the question appears, another one replaces it, or the link comes back.
  useEffect(() => {
    setDialog(null)
    setNote("")
    setBusy(null)
    if (online) send({ t: "dialog", pane: pane.id, waitId })
  }, [send, pane.id, waitId, online, epoch])

  const answer = (n: number) => {
    if (!dialog?.d) return
    setNote("")
    // What this phone showed: main types the key only if the screen still shows exactly that.
    const seen = dialogSignature(dialog.d)
    if (!send({ t: "answer", pane: pane.id, waitId, n, seen })) return setNote(REASON.error)
    setBusy(n)
  }

  return (
    <section className="asking" aria-label={`${agentName} is asking`}>
      <span className="ask-label">
        <span className="dot wait" /> {agentName} is asking
      </span>
      {dialog?.d ? (
        <>
          <div className="answer-question">{dialog.d.question}</div>
          {/* What it asks about (the command, the file): never approve something unseen. */}
          {dialog.d.body.length > 0 && (
            <pre className="answer-body">{dialog.d.body.join("\n")}</pre>
          )}
          {pane.detail && <div className="answer-detail">{pane.detail}</div>}
        </>
      ) : (
        <div className="answer-question">{pane.detail ?? "A question"}</div>
      )}
      {dialog?.d && (
        <div className="answer-options">
          {dialog.d.options.map((o) =>
            dialog.answerable && canAnswer ? (
              <button
                key={o.n}
                className={o.n === 1 ? "first" : ""}
                disabled={busy !== null}
                onClick={() => answer(o.n)}
              >
                <span className="answer-n">{o.n}</span>
                <span className="answer-label">{o.label}</span>
                {busy === o.n && <span className="answer-busy">…</span>}
              </button>
            ) : (
              <div key={o.n} className="answer-option">
                <span className="answer-n">{o.n}</span>
                <span className="answer-label">{o.label}</span>
              </div>
            ),
          )}
        </div>
      )}
      {dialog && (!dialog.d || !dialog.answerable || !canAnswer) && (
        <div className="answer-foot">
          {!dialog.d
            ? "Its options aren't on screen."
            : !canAnswer
              ? "This device can only view: answer it on the computer."
              : keysAllowed
                ? "Answer it in the Terminal view, with the keys bar."
                : "Answer it on the computer (this device can't type raw keys)."}{" "}
          {(!dialog.d || keysAllowed) && (
            <button className="link" onClick={openTerminal}>
              Open the Terminal view
            </button>
          )}
        </div>
      )}
      {note && <div className="answer-note">{note}</div>}
      <button
        className="link look"
        onClick={() => {
          setBusy(null)
          send({ t: "dialog", pane: pane.id, waitId })
        }}
      >
        Look again
      </button>
    </section>
  )
}
