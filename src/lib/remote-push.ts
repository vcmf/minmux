// Pushes the pane list to main while a remote client is connected (nothing otherwise): on
// store changes, at most every PUSH_MS, and only when what a client sees changed.

import type { RemotePanes } from "./remote-protocol"
import { samePanes } from "./remote-panes"

export const PUSH_MS = 250
// Also rebuilt this often while wanted: a program turning bracketed paste on or off isn't a store
// change (it's the terminal's own state), and main types messages by it.
export const REFRESH_MS = 1000

export interface RemotePushDeps {
  build: () => RemotePanes
  send: (p: RemotePanes) => void
  subscribe: (fn: () => void) => () => void
  wanted: () => Promise<boolean>
  onWanted: (fn: (w: boolean) => void) => () => void
}

/** Starts following "wanted"; returns a stop function. */
export function startRemotePush(d: RemotePushDeps): () => void {
  let wanted = false
  let unsub: (() => void) | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  let last: RemotePanes | null = null
  const push = () => {
    const p = d.build()
    if (samePanes(last, p)) return
    last = p
    d.send(p)
  }
  const schedule = () => {
    if (timer) return
    timer = setTimeout(() => {
      timer = null
      if (wanted) push()
    }, PUSH_MS)
  }
  const set = (w: boolean) => {
    if (w === wanted) return
    wanted = w
    if (w) {
      last = null
      push()
      const off = d.subscribe(schedule)
      const refresh = setInterval(schedule, REFRESH_MS)
      unsub = () => {
        off()
        clearInterval(refresh)
      }
    } else {
      unsub?.()
      unsub = null
    }
  }
  let stopped = false
  void d.wanted().then((w) => !stopped && set(w))
  const off = d.onWanted(set)
  return () => {
    stopped = true
    off()
    unsub?.()
    if (timer) clearTimeout(timer)
  }
}
