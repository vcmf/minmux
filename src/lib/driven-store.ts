// Panes another machine is sizing right now (remote control): the pane header's chip.
import { create } from "zustand"

export const useDriven = create<{
  by: Record<string, string> // session id → the machine sizing it
  set: (id: string, by: string | null) => void
}>((set) => ({
  by: {},
  set: (id, by) =>
    set((s) => {
      if ((s.by[id] ?? null) === by) return s
      const next = { ...s.by }
      if (by === null) delete next[id]
      else next[id] = by
      return { by: next }
    }),
}))
