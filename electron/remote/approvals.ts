// A device asking in (docs/design/REMOTE_CONTROL.md): the desktop window shows the request in
// its own dialog. No window, or it didn't show the request soon, and a native prompt asks.

import { isPermission } from "../../src/lib/remote-protocol"
import type { ApprovalRequest } from "../../src/lib/remote-view"
import type { Decision } from "./devices"

export type { ApprovalRequest }

export interface ApprovalsDeps {
  /** The open requests, to the window. False when there's no window to show them. */
  show: (list: ApprovalRequest[]) => boolean
  /** The native prompt, closed by the signal (answered in the window meanwhile, or expired). */
  native: (r: ApprovalRequest, signal: AbortSignal) => Promise<Decision>
  ttlMs: number
  ackMs?: number // the window says it shows a request within this, else the native prompt
  now?: () => number
}

interface Open {
  req: ApprovalRequest
  resolve: (d: Decision) => void
  shown: boolean
  asking: boolean // the native prompt is up
  abort: AbortController
  ttl: ReturnType<typeof setTimeout>
  ack?: ReturnType<typeof setTimeout>
}

export const isDecision = (v: unknown): v is Decision =>
  v === "allow" || v === "deny" || isPermission(v)

export function createApprovals(d: ApprovalsDeps) {
  const open = new Map<number, Open>()
  let next = 0
  const now = d.now ?? Date.now
  const list = () => [...open.values()].map((o) => o.req)

  function finish(id: number, decision: Decision): boolean {
    const o = open.get(id)
    if (!o) return false
    open.delete(id)
    clearTimeout(o.ttl)
    if (o.ack) clearTimeout(o.ack)
    o.abort.abort()
    o.resolve(decision)
    d.show(list())
    return true
  }

  function native(o: Open) {
    if (!open.has(o.req.id) || o.asking) return
    o.asking = true
    d.native(o.req, o.abort.signal).then(
      (v) => finish(o.req.id, v),
      () => finish(o.req.id, "deny"),
    )
  }

  return {
    /** Ask the desktop's user; an unanswered request is denied when it expires. */
    ask(name: string, code: string, machine: boolean): Promise<Decision> {
      const id = ++next
      const req: ApprovalRequest = { id, name, code, machine, expires: now() + d.ttlMs }
      return new Promise((resolve) => {
        const o: Open = {
          req,
          resolve,
          shown: false,
          asking: false,
          abort: new AbortController(),
          ttl: setTimeout(() => finish(id, "deny"), d.ttlMs),
        }
        open.set(id, o)
        if (d.show(list())) o.ack = setTimeout(() => !o.shown && native(o), d.ackMs ?? 1500)
        else native(o)
      })
    },
    list,
    /** The window shows this request (its dialog is up). */
    shown(id: unknown) {
      const o = typeof id === "number" ? open.get(id) : undefined
      if (o) o.shown = true
    },
    /** The window reloads or its renderer died: each request must be shown again soon (the
     *  reloaded window fetches the list), else the native prompt asks. */
    unshown() {
      for (const o of open.values()) {
        if (!o.shown) continue
        o.shown = false
        if (o.ack) clearTimeout(o.ack)
        o.ack = setTimeout(() => !o.shown && native(o), d.ackMs ?? 1500)
      }
    },
    /** The window's answer. False when the request is gone (answered, expired) or it's no answer. */
    answer(id: unknown, decision: unknown): boolean {
      if (typeof id !== "number" || !isDecision(decision)) return false
      return finish(id, decision)
    },
    dispose() {
      for (const id of [...open.keys()]) finish(id, "deny")
    },
  }
}
