// Which device just typed into which pane (remote control): the sidebar shows "from <device>"
// on the row for SHOW_MS after a message from a phone or another machine.
import { create } from "zustand"

export const SHOW_MS = 10_000

interface RemoteTyped {
  by: Record<string, string> // pane id → device name
  typed: (pane: string, device: string) => void
}

const timers = new Map<string, ReturnType<typeof setTimeout>>()

export const useRemoteTyped = create<RemoteTyped>((set) => ({
  by: {},
  typed: (pane, device) => {
    clearTimeout(timers.get(pane))
    set((s) => ({ by: { ...s.by, [pane]: device } }))
    timers.set(
      pane,
      setTimeout(() => {
        timers.delete(pane)
        set((s) => {
          const rest = { ...s.by }
          delete rest[pane]
          return { by: rest }
        })
      }, SHOW_MS),
    )
  },
}))
