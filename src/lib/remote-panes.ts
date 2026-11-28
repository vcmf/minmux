// The pane list remote clients see (docs/design/REMOTE_CONTROL.md): built from the store while
// a client is connected. An agent pane's status comes from its lead session in the agent graph
// (the sidebar's signals never flag the pane you're looking at; the phone isn't looking at it).

import { paneLeads, type AgentGraph, type AgentStatus } from "./agent-graph"
import { allSessionIds } from "./pane-tree"
import type { RemotePane, RemotePanes, RemoteStatus, RemoteTab } from "./remote-protocol"
import { messageSnippet, type PaneGitInfo } from "./pane-git"
import {
  displaySessionTitle,
  remoteRowTitle,
  sessionSubline,
  shellType,
  tabTitle,
} from "./session-label"
import type { Session, Tab } from "../types"

const AGENT_STATUS: Record<AgentStatus, RemoteStatus> = {
  working: "working",
  waiting: "waiting",
  idle: "idle",
  done: "idle",
}

export interface RemotePanesInput {
  tabs: Tab[]
  sessions: Record<string, Session>
  agents: AgentGraph
  home: string
  started: (id: string) => boolean
  paste?: (id: string) => boolean | undefined
  color?: (id: string) => string | undefined // the agent session's accent (a dark-theme hex)
  git?: (id: string) => PaneGitInfo | undefined // its branch and PR, as the sidebar has them
}

export function buildRemotePanes(i: RemotePanesInput): RemotePanes {
  const leads = paneLeads(i.agents)
  const panes: RemotePane[] = []
  const tabs = i.tabs.map((tab) => {
    for (const id of allSessionIds(tab.root)) {
      const s = i.sessions[id]
      if (!s || s.peer) continue // another minmux's pane: not this machine's to offer
      const lead = leads[id]
      const status: RemoteStatus = lead
        ? AGENT_STATUS[lead.status]
        : s.status === "working"
          ? "working"
          : s.status === "attention"
            ? "waiting"
            : "idle"
      const pane: RemotePane = {
        id,
        tab: tab.id,
        title: s.remote ? remoteRowTitle(s, i.home) : displaySessionTitle(s, i.home),
        kind: s.remote ? "ssh" : lead ? "agent" : "shell",
        status,
        started: i.started(id),
      }
      if (lead) pane.agent = lead.agent
      const color = lead ? i.color?.(id) : undefined
      if (color) pane.color = color
      const paste = i.paste?.(id)
      if (paste !== undefined) pane.paste = paste
      const detail = status === "waiting" ? (s.detail ?? lead?.lastMessage) : undefined
      if (detail) pane.detail = detail.slice(0, 200)
      const cwd = s.remote ? s.remoteCwd : s.cwd
      if (cwd) pane.cwd = cwd
      if (!s.remote) {
        pane.shell = shellType(s.command)
        const git = i.git?.(id)
        if (git?.branch) pane.branch = git.branch
        if (git?.pr) pane.pr = { number: git.pr.number, state: git.pr.state }
        const where = sessionSubline(s.cwd, i.home, git?.branch)
        if (where) pane.where = where
      } else if (s.remoteCwd) pane.where = s.remoteCwd
      const snippet = status !== "waiting" ? messageSnippet(lead?.lastMessage) : ""
      if (snippet) pane.snippet = snippet.slice(0, 160)
      panes.push(pane)
    }
    const focused = i.sessions[tab.activeSessionId]
    const out: RemoteTab = { id: tab.id, title: tabTitle(tab, i.sessions, i.home) }
    if (focused && !focused.remote && !focused.peer) {
      const sub = sessionSubline(focused.cwd, i.home, i.git?.(tab.activeSessionId)?.branch)
      if (sub) out.sub = sub
      out.shell = shellType(focused.command)
    }
    return out
  })
  return { tabs, panes, stale: false }
}

/** Same content (a push is skipped when nothing a client sees changed). */
export const samePanes = (a: RemotePanes | null, b: RemotePanes): boolean =>
  !!a && JSON.stringify(a) === JSON.stringify(b)
