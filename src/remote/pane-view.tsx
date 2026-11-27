import { useEffect, useLayoutEffect, useRef, useState } from "react"
import type { ChatItem, ChatQuestion } from "../lib/remote-chat"
import type { HostMessage, Permission, RemotePane } from "../lib/remote-protocol"
import {
  acked,
  applyChat,
  emptyChat,
  refusalText,
  resendable,
  type ChatState,
  type Outgoing,
} from "./chat-state"

export interface PaneViewProps {
  pane: RemotePane
  permission: Permission
  online: boolean // the link is open (welcomed)
  epoch: number // bumps on every welcome: re-watch, resend
  send: (m: unknown) => boolean
  subscribe: (fn: (m: HostMessage) => void) => () => void
  onBack: () => void
}

const AGENT: Record<string, string> = { claude: "Claude", codex: "Codex", opencode: "OpenCode" }
const newId = () => Math.random().toString(36).slice(2, 12) + Date.now().toString(36)

/** One pane on the phone: its agent conversation (chat view) and a message box. */
export function PaneView({
  pane,
  permission,
  online,
  epoch,
  send,
  subscribe,
  onBack,
}: PaneViewProps) {
  const [chat, setChat] = useState<ChatState>(emptyChat)
  const [out, setOut] = useState<Outgoing[]>([])
  const [draft, setDraft] = useState("")
  const outRef = useRef(out)
  outRef.current = out
  const list = useRef<HTMLDivElement>(null)
  const stick = useRef(true) // follow new items while the reader is at the bottom

  useEffect(
    () =>
      subscribe((m) => {
        if (m.t === "chat" && m.pane === pane.id) setChat((s) => applyChat(s, m))
        if (m.t === "ack") setOut((o) => acked(o, m))
      }),
    [subscribe, pane.id],
  )

  // Each (re)connect: watch again, and send again what got no answer (same id: typed once).
  useEffect(() => {
    if (!online) return
    send({ t: "watch", pane: pane.id })
    const { again, next } = resendable(outRef.current, Date.now())
    setOut(next)
    for (const o of again) send({ t: "send", pane: o.pane, text: o.text, id: o.id })
    return () => void send({ t: "unwatch", pane: pane.id })
  }, [online, epoch, pane.id, send])

  useLayoutEffect(() => {
    const el = list.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [chat.items, out])

  const agentName = AGENT[pane.agent ?? ""] ?? "The agent"
  const asking = !!pane.asking
  const canSend = permission !== "view" && online && pane.started && !asking

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    const text = draft.trim()
    if (!text || !canSend) return
    const o: Outgoing = { id: newId(), pane: pane.id, text, at: Date.now(), state: "sending" }
    setOut((x) => [...x.slice(-20), o])
    setDraft("")
    stick.current = true
    if (!send({ t: "send", pane: pane.id, text, id: o.id }))
      setOut((x) => acked(x, { t: "ack", id: o.id, ok: false, reason: "error" }))
  }

  const older = () => {
    const first = chat.items[0]
    if (first) send({ t: "more", pane: pane.id, before: first.id })
  }

  return (
    <div className="pane-view">
      <header className="pane-head">
        <button className="back" onClick={onBack}>
          ‹ Panes
        </button>
        <span className="pane-title">{pane.title}</span>
        <span
          className={`word ${pane.status === "working" ? "run" : pane.status === "waiting" ? "wait" : "idle"}`}
        >
          {pane.status === "waiting" ? "needs input" : pane.status}
        </span>
      </header>

      <div
        className="chat"
        ref={list}
        onScroll={(e) => {
          const el = e.currentTarget
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
        }}
      >
        {chat.more && (
          <button className="older" onClick={older}>
            Load earlier
          </button>
        )}
        {!chat.loaded && <p className="dim pad">Loading…</p>}
        {chat.unavailable === "no-agent" && (
          <p className="dim pad">
            No agent conversation here. You can still send a line to this{" "}
            {pane.kind === "ssh" ? "ssh session" : "shell"}; its terminal view comes in a later
            update.
          </p>
        )}
        {chat.unavailable === "error" && (
          <p className="warn pad">
            This agent's conversation couldn't be read. Its terminal view comes in a later update.
          </p>
        )}
        {chat.items.map((it) => (
          <Item key={it.id} item={it} />
        ))}
        {out
          .filter((o) => o.pane === pane.id && o.state !== "sent")
          .map((o) => (
            <div key={o.id} className={`msg user pending ${o.state}`}>
              <div className="text">{o.text}</div>
              <div className="meta">
                {o.state === "sending" ? "Sending…" : refusalText(o.reason)}
                {o.state === "failed" && o.reason !== "not-allowed" && (
                  <button
                    className="retry"
                    onClick={() => {
                      setOut((x) => x.filter((y) => y.id !== o.id))
                      setDraft(o.text)
                    }}
                  >
                    Edit and retry
                  </button>
                )}
              </div>
            </div>
          ))}
      </div>

      {asking && (
        <div className="asking">
          <b>{agentName} is asking something.</b> {pane.detail ? `${pane.detail}. ` : ""}Answer it
          on the computer for now; answering from here comes in a later update.
        </div>
      )}
      <form className="composer" onSubmit={submit}>
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={
            permission === "view"
              ? "View only"
              : !pane.started
                ? "Not started on the computer"
                : pane.kind === "agent"
                  ? `Message ${agentName}…`
                  : "A line for this shell…"
          }
          rows={2}
          disabled={permission === "view" || !pane.started}
          aria-label="Message"
        />
        <button className="button" disabled={!canSend || !draft.trim()}>
          Send
        </button>
      </form>
    </div>
  )
}

function Item({ item }: { item: ChatItem }) {
  const [open, setOpen] = useState(false)
  switch (item.kind) {
    case "user":
      return (
        <div className="msg user">
          <div className="text">{item.text}</div>
        </div>
      )
    case "assistant":
      return (
        <div className="msg assistant">
          <div className="text">{item.text}</div>
        </div>
      )
    case "tool":
      return (
        <button className={`tool${item.error ? " error" : ""}`} onClick={() => setOpen((v) => !v)}>
          <span className="tool-name">{item.name}</span>
          <span className="tool-summary">{item.summary}</span>
          {open && item.result !== undefined && (
            <pre className="tool-result">{item.result || "(no output)"}</pre>
          )}
        </button>
      )
    case "question":
      return <QuestionCard item={item} />
  }
}

function QuestionCard({ item }: { item: Extract<ChatItem, { kind: "question" }> }) {
  return (
    <div className={`question${item.answer ? " answered" : ""}`}>
      {item.questions.map((q, i) => (
        <Question key={i} q={q} />
      ))}
      {item.answer ? (
        <div className="answer">
          <span className="dim">Answered:</span> {item.answer}
        </div>
      ) : (
        <div className="dim small">Answer on the computer for now.</div>
      )}
    </div>
  )
}

function Question({ q }: { q: ChatQuestion }) {
  return (
    <div className="q">
      {q.header && <div className="q-header">{q.header}</div>}
      <div className="q-text">{q.question}</div>
      {q.multi && <div className="dim small">Several can be picked</div>}
      <ol className="q-options">
        {q.options.map((o, i) => (
          <li key={i}>
            <span className="q-label">{o.label}</span>
            {o.description && <span className="q-desc">{o.description}</span>}
          </li>
        ))}
      </ol>
    </div>
  )
}
