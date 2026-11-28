import { useEffect, useLayoutEffect, useRef, useState } from "react"
import type { ChatItem, ChatQuestion } from "../lib/remote-chat"
import type { HostMessage, Permission, RemotePane } from "../lib/remote-protocol"
import { applyChat, emptyChat, refusalText, type ChatState } from "./chat-state"
import type { Outbox } from "./outbox"
import { TerminalView } from "./terminal-view"
import { AnswerCard } from "./answer-card"

export interface PaneViewProps {
  pane: RemotePane
  permission: Permission
  online: boolean // the link is open (welcomed)
  epoch: number // bumps on every welcome: re-watch, resend
  send: (m: unknown) => boolean
  subscribe: (fn: (m: HostMessage) => void) => () => void
  outbox: Outbox
  onBack: () => void
}

const AGENT: Record<string, string> = { claude: "Claude", codex: "Codex", opencode: "OpenCode" }

/** One pane on the phone: its agent conversation (chat view) and a message box. */
export function PaneView({
  pane,
  permission,
  online,
  epoch,
  send,
  subscribe,
  outbox,
  onBack,
}: PaneViewProps) {
  const [chat, setChat] = useState<ChatState>(emptyChat)
  const out = outbox.out
  const [draft, setDraft] = useState("")
  const list = useRef<HTMLDivElement>(null)
  const box = useRef<HTMLTextAreaElement>(null)
  useLayoutEffect(() => {
    if (box.current) grow(box.current) // typed, sent (empty again) or put back to retry
  }, [draft])
  const stick = useRef(true) // follow new items while the reader is at the bottom

  useEffect(
    () =>
      subscribe((m) => {
        if (m.t === "chat" && m.pane === pane.id) setChat((s) => applyChat(s, m))
      }),
    [subscribe, pane.id],
  )

  // Chat for an agent pane, the terminal for a shell; either can be switched to.
  const [view, setView] = useState<"chat" | "terminal">(pane.kind === "agent" ? "chat" : "terminal")

  // Each (re)connect: watch again (the outbox resends what got no answer).
  useEffect(() => {
    if (!online || view !== "chat") return
    send({ t: "watch", pane: pane.id })
    return () => void send({ t: "unwatch", pane: pane.id })
  }, [online, epoch, pane.id, send, view])

  useLayoutEffect(() => {
    const el = list.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [chat.items, out])

  const agentName = AGENT[pane.agent ?? ""] ?? "The agent"
  const asking = !!pane.asking
  const working = !!pane.working && !asking // main sets it for agent panes only
  const canSend = permission !== "view" && online && pane.started && !asking && !working

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    const text = draft.trim()
    if (!text || !canSend) return
    outbox.enqueue(pane.id, text)
    setDraft("")
    stick.current = true
  }

  const older = () => {
    const first = chat.items[0]
    if (first) send({ t: "more", pane: pane.id, before: first.id, seq: first.seq })
  }

  return (
    <div className="pane-view">
      <header className="pane-head">
        <button className="back" onClick={onBack} aria-label="Back to panes">
          <svg
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
          >
            <path d="M15 6l-6 6 6 6" />
          </svg>
        </button>
        <span className="pane-names">
          <span className="pane-title">{pane.title}</span>
          <span className="pane-status">
            <span
              className={`dot ${pane.status === "working" ? "run" : pane.status === "waiting" ? "wait" : "idle"}`}
            />
            {pane.agent ? `${agentName} · ` : ""}
            {pane.status === "waiting" ? "needs you" : pane.status}
          </span>
        </span>
        <div className="view-toggle" role="tablist" aria-label="View">
          {(["chat", "terminal"] as const).map((v) => (
            <button
              key={v}
              role="tab"
              aria-selected={view === v}
              className={view === v ? "on" : ""}
              onClick={() => setView(v)}
            >
              {v === "chat" ? "Chat" : "Terminal"}
            </button>
          ))}
        </div>
      </header>

      {view === "terminal" ? (
        <TerminalView
          pane={pane}
          permission={permission}
          online={online}
          epoch={epoch}
          send={send}
          subscribe={subscribe}
        />
      ) : (
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
          {chat.unavailable === "no-agent" &&
            (pane.kind === "agent" ? (
              <p className="dim pad">
                This agent&apos;s conversation can&apos;t be shown here. Open its Terminal view
                instead.
              </p>
            ) : (
              <p className="dim pad">
                No agent conversation here. Its Terminal view shows the{" "}
                {pane.kind === "ssh" ? "ssh session" : "shell"}; you can still send it a line.
              </p>
            ))}
          {chat.unavailable === "error" && (
            <p className="warn pad">
              This agent's conversation couldn't be read. Its Terminal view still works.
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
                  {/* Held: the text is already in the agent's input box; another try would paste it twice. */}
                  {o.state === "failed" && o.reason !== "not-allowed" && o.reason !== "held" && (
                    <button
                      className="retry"
                      onClick={() => {
                        outbox.discard(o.id)
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
      )}

      {asking && (
        <AnswerCard
          pane={pane}
          agentName={agentName}
          canAnswer={permission !== "view" && online}
          keysAllowed={permission === "keys"}
          online={online}
          epoch={epoch}
          send={send}
          subscribe={subscribe}
          openTerminal={() => setView("terminal")}
        />
      )}
      {working && (
        <div className="working-note">
          <span className="dots" aria-hidden>
            <span />
            <span />
            <span />
          </span>
          {agentName} is working. Write now, send once it finishes.
        </div>
      )}
      <form className="composer" onSubmit={submit}>
        <textarea
          value={draft}
          ref={box}
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
          rows={1}
          disabled={permission === "view" || !pane.started}
          aria-label="Message"
        />
        <button className="send" aria-label="Send" disabled={!canSend || !draft.trim()}>
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.4"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
          >
            <path d="M12 19V5M6 11l6-6 6 6" />
          </svg>
        </button>
      </form>
    </div>
  )
}

/** The message box grows with its text, up to its max height (no `field-sizing` in Safari). */
function grow(el: HTMLTextAreaElement) {
  el.style.height = "auto"
  el.style.height = `${el.scrollHeight}px`
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
        <div className={`tool${item.error ? " error" : ""}`}>
          {/* Only the header toggles: the output below can be selected and copied. */}
          <button className="tool-head" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
            <ToolIcon name={item.name} />
            <span className="tool-name">{item.name}</span>
            <span className="tool-summary">{item.summary}</span>
          </button>
          {open && item.result !== undefined && (
            <pre className="tool-result">{item.result || "(no output)"}</pre>
          )}
        </div>
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

const TOOL_PATHS: [RegExp, string][] = [
  [/^(Read|NotebookRead)$/, "M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9zM14 3v6h6"],
  [
    /^(Edit|MultiEdit|Write|NotebookEdit|apply_patch)$/,
    "M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z",
  ],
  [/^(Bash|shell|exec|local_shell)$/, "M4 17l6-5-6-5M12 19h8"],
  [/^(Grep|Glob|LS|search)$/, "M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4-4"],
  [
    /^Web/,
    "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM3 12h18M12 3c3 3.5 3 14.5 0 18M12 3c-3 3.5-3 14.5 0 18",
  ],
]

/** A small line icon per kind of tool (files read, edits, commands, searches, the web). */
function ToolIcon({ name }: { name: string }) {
  const d = TOOL_PATHS.find(([re]) => re.test(name))?.[1] ?? "M12 11a1 1 0 1 0 0 2 1 1 0 0 0 0-2z"
  return (
    <svg
      className="tool-icon"
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d={d} />
    </svg>
  )
}
