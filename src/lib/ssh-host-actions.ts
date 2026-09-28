// The host menu's actions: store and ipc glue shared by the picker and the sidebar.

import { useStore } from "../store"
import { ipc } from "./ipc"
import { sshCommand, type HostActionId } from "./ssh-host-list"
import type { SshHost } from "../types"

/** Run a host-menu action (shared by the picker and the sidebar's host rows). */
export function runHostAction(h: SshHost, id: HostActionId) {
  const st = useStore.getState()
  if (id === "open") st.openHost(h, "tab")
  else if (id === "splitRight") st.openHost(h, "row")
  else if (id === "splitDown") st.openHost(h, "column")
  else if (id === "copyCommand") ipc.clipboardWrite(sshCommand(h))
  else if (id === "pin") st.toggleHostPinned(h.hostId)
  else if (id === "hide") st.setHostHidden(h.label, true)
  else ipc.openSshConfig()
}
