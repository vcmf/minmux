// The phone's unsent messages, kept above any one pane screen: an ack or a resend after a
// reconnect still lands when the user went back to the pane list meanwhile.
import { useCallback, useEffect, useRef, useState } from "react"
import type { HostMessage } from "../lib/remote-protocol"
import { acked, resendable, type Outgoing } from "./chat-state"

const newId = () => Math.random().toString(36).slice(2, 12) + Date.now().toString(36)

export interface Outbox {
  out: Outgoing[]
  enqueue: (pane: string, text: string) => void
  discard: (id: string) => void
}

export function useOutbox(
  send: (m: unknown) => boolean,
  subscribe: (fn: (m: HostMessage) => void) => () => void,
  online: boolean,
  epoch: number,
): Outbox {
  const [out, setOut] = useState<Outgoing[]>([])
  const ref = useRef(out)
  ref.current = out

  useEffect(() => subscribe((m) => m.t === "ack" && setOut((o) => acked(o, m))), [subscribe])

  // Each (re)connect: send again what got no answer (same id: typed once), fail what's too old.
  useEffect(() => {
    if (!online) return
    const { again, next } = resendable(ref.current, Date.now())
    setOut(next)
    for (const o of again) send({ t: "send", pane: o.pane, text: o.text, id: o.id })
  }, [online, epoch, send])

  const enqueue = useCallback(
    (pane: string, text: string) => {
      const o: Outgoing = { id: newId(), pane, text, at: Date.now(), state: "sending" }
      setOut((x) => [...x.slice(-30), o])
      if (!send({ t: "send", pane, text, id: o.id }))
        setOut((x) => acked(x, { t: "ack", id: o.id, ok: false, reason: "error" }))
    },
    [send],
  )
  const discard = useCallback((id: string) => setOut((x) => x.filter((o) => o.id !== id)), [])
  return { out, enqueue, discard }
}
