import { useStore } from "../store"
import { defaultSettings } from "../settings/schema"
import type { ShellOption, SshEnv, SshHost } from "../types"
import { emptyGraph } from "../lib/agent-graph"

export const testShell: ShellOption = { id: "sh", label: "sh", command: "/bin/sh", args: [] }

/** A saved ssh host as main lists it. */
export const testHost = (alias: string, env: SshEnv = "native", detail?: string): SshHost => ({
  hostId: env === "native" ? `native:${alias}` : `${env}:${alias}`,
  label: alias,
  target: alias,
  env,
  ...(detail ? { detail } : {}),
})

/** Reset the singleton store to a clean initial state between tests (keeps actions). */
export function resetStore() {
  useStore.setState({
    sessions: {},
    tabs: [],
    activeTabId: null,
    shells: [testShell],
    sshHosts: [],
    windowFocused: true,
    systemDark: true,
    settingsLoaded: false,
    settings: defaultSettings,
    settingsOpen: false,
    paletteOpen: false,
    searchOpen: false,
    rightView: null,
    sidebarCollapsed: false,
    git: null,
    paneRoot: {},
    closePaneConfirm: null,
    dragging: null,
    agentMeta: {},
    agents: emptyGraph,
    paneGit: {},
    resume: {},
  })
}
