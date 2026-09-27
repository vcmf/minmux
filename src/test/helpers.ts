import { useStore } from "../store"
import { defaultSettings } from "../settings/schema"
import type { ShellOption } from "../types"
import { emptyGraph } from "../lib/agent-graph"

export const testShell: ShellOption = { id: "sh", label: "sh", command: "/bin/sh", args: [] }

/** Reset the singleton store to a clean initial state between tests (keeps actions). */
export function resetStore() {
  useStore.setState({
    sessions: {},
    tabs: [],
    activeTabId: null,
    shells: [testShell],
    profile: "",
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
