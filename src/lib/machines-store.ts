// The machines list (main's remote-client worker): the sidebar's Machines rows.
import { create } from "zustand"
import type { MachineView } from "./remote-machines"

export const useMachines = create<{ list: MachineView[]; set: (l: MachineView[]) => void }>(
  (set) => ({ list: [], set: (list) => set({ list }) }),
)
