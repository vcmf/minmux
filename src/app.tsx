import { useEffect, useLayoutEffect } from "react"
import { nextGitPollDelay } from "./lib/git-poll"
import { ipc } from "./lib/ipc"
import { TopBar } from "./components/top-bar"
import { Sidebar } from "./components/sidebar"
import { StatusBar } from "./components/status-bar"
import { CommandPalette } from "./components/command-palette"
import { HostPicker } from "./components/host-picker"
import { SearchBar } from "./components/search-bar"
import { DiffPanel } from "./components/diff-panel"
import { AgentsPanel } from "./components/agents-panel"
import { FilesPanel } from "./components/files-panel"
import { PaneLayout } from "./components/pane-layout"
import { SettingsPanel } from "./components/settings-panel"
import { FilePreview } from "./components/file-preview"
import { CloseConfirmDialog } from "./components/close-confirm-dialog"
import { RightPanelResizer } from "./components/right-panel-resizer"
import { useActiveWorkCwd, getActiveWsl } from "./lib/use-active-cwd"
import { agentWorkDirs, keepPrs, planGitPoll, settleInAnswers } from "./lib/agent-dirs"
import { TerminalManager } from "./terminal/terminal-manager"
import { activeTheme, useStore } from "./store"
import { ensureNotificationPermission } from "./lib/notify"
import { loadSettings } from "./settings/io"
import { applyThemeVars } from "./settings/themes"
import { readWorkspaceFile, serializeToJson } from "./lib/workspace"
import { appShortcut } from "./lib/terminal-keys"
import { wslContext } from "./lib/wsl"
import { isPosixShell, type ResumePlan } from "./lib/resume"
import { resolveDefaultShell } from "./lib/shells"
import { isMac } from "./lib/platform"
import type { ShellOption } from "./types"
import "@xterm/xterm/css/xterm.css"
import "./App.css"

// Set when workspace.json was written by a NEWER build: we can't read it, so we must not
// overwrite it either (a downgrade would otherwise wipe the saved layout).
let persistBlocked = false

/** How long after mount the host list is first fetched (the first tab spawns before). */
const SSH_HOSTS_DELAY_MS = 800

function App() {
  const tabs = useStore((s) => s.tabs)
  const activeTabId = useStore((s) => s.activeTabId)
  const settings = useStore((s) => s.settings)
  const settingsLoaded = useStore((s) => s.settingsLoaded)
  const theme = useStore(activeTheme) // stable object per variant — changes only on a real switch
  const settingsOpen = useStore((s) => s.settingsOpen)
  const paletteOpen = useStore((s) => s.paletteOpen)
  const hostPickerOpen = useStore((s) => s.hostPickerOpen)
  const searchOpen = useStore((s) => s.searchOpen)
  const rightView = useStore((s) => s.rightView)
  const rightPanelWidth = useStore((s) => s.rightPanelWidth)
  const sidebarCollapsed = useStore((s) => s.sidebarCollapsed)
  const activeCwd = useActiveWorkCwd() // Claude's folder while it runs (worktree), else the shell's

  // Load shells + settings, then restore the saved workspace (VS Code-style) or open a tab.
  // Settings first: a restored pane spawns with the theme's bg (COLORFGBG light/dark), and
  // the theme must not be painted from defaults before settings.json is read.
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      let shells: ShellOption[] = []
      const settingsP = loadSettings()
      try {
        shells = await ipc.listShells()
      } catch {
        // Running without a backend (e.g. plain browser) — fall through.
      }
      const loaded = await settingsP
      if (cancelled) return
      useStore.getState().setSettings(loaded)
      if (shells.length === 0) {
        shells = [{ id: "default", label: "shell", command: "", args: [] }]
      }
      const store = useStore.getState()
      store.setShells(shells)
      if (store.tabs.length === 0) {
        let restored = null
        try {
          const file = readWorkspaceFile(await ipc.readWorkspace())
          persistBlocked = file.newer
          restored = file.state
        } catch {
          // no/invalid workspace — start fresh
        }
        if (cancelled) return
        if (restored) {
          // Panes that were inside a Claude session when minmux quit/crashed: ask main what
          // to resume BEFORE restoring, so those shells spawn in the session's own cwd.
          const plans =
            loaded.resumeAgents === "off"
              ? {}
              : await ipc
                  .resumePlan(Object.keys(restored.sessions), loaded.resumeBypassPermissions)
                  .catch(() => ({}) as Record<string, ResumePlan>)
          if (cancelled) return
          // Auto: spawn right in the session's cwd. Ask: keep the pane's own cwd (a Dismiss
          // must leave it where it was) and make the command `cd` there first — on POSIX
          // shells; pwsh/cmd can't take that, so they spawn in the session's cwd either way.
          // The typed command cd's into the session's dir on POSIX shells (terminal-manager).
          // So only move the spawn cwd where that's both needed and safe: auto mode, a host
          // shell (a missing Linux dir as a WSL spawn cwd stops the shell from starting), and
          // a shell that can't take the cd form. Ask mode keeps the pane's own cwd (Dismiss).
          // An unverified cwd (its stat timed out — a hung mount) is never a spawn cwd: the
          // spawn's own existence check would block main.
          const ask = loaded.resumeAgents === "ask"
          for (const [id, plan] of Object.entries(plans)) {
            const s = restored.sessions[id]
            if (!s || plan.status !== "resume" || !plan.command || plan.cwdUnverified) continue
            const wsl = !!wslContext(s.command, s.args)
            // Non-POSIX shells can't take the typed cd, so they spawn there even in ask mode.
            if (!wsl && (!ask || !isPosixShell(s.command))) s.cwd = plan.cwd
          }
          // After a renderer reload main still runs some of these: those aren't "restored".
          const livePtys = await ipc.ptyLiveIds().catch(() => [] as string[])
          if (cancelled) return
          store.restoreWorkspace(restored, livePtys)
          for (const [id, plan] of Object.entries(plans)) {
            if (plan.status === "skip") ipc.resumeConsume(id, plan.sessionId) // can't succeed — tell
            store.setResume(
              id,
              plan.status === "skip"
                ? { phase: "skipped", plan }
                : loaded.resumeAgents === "ask"
                  ? { phase: "offer", plan }
                  : { phase: "pending", plan }, // terminal-manager types it at the first prompt
            )
          }
          // After a renderer reload main still holds PTYs for sessions the restore dropped.
          for (const id of restored.pruned ?? []) ipc.ptyKill(id)
          // …and the Claude accents of the ones it kept (the store restarted empty).
          void ipc.agentMetaSnapshot().then((all) => {
            for (const [paneId, meta] of all) useStore.getState().setAgentMeta(paneId, meta)
          })
        } else if (shells[0]) store.newTab(shells[0])
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  // Saved ssh hosts: fetched off the startup path (the first tab never waits on it), then
  // re-fetched whenever main sees ~/.ssh/config change. A late answer never overwrites a newer.
  useEffect(() => {
    let seq = 0
    let disposed = false
    const refresh = () => {
      const mine = ++seq
      try {
        void ipc
          .listSshHosts()
          .then((hosts) => {
            if (!disposed && mine === seq && hosts) useStore.getState().setSshHosts(hosts)
          })
          .catch(() => undefined) // main failed: keep the last list
      } catch {
        // no backend
      }
    }
    // After the startup spawns are under way: main builds its host list lazily.
    const first = setTimeout(refresh, SSH_HOSTS_DELAY_MS)
    let off: (() => void) | undefined
    try {
      off = ipc.onSshHostsChanged(refresh)
    } catch {
      // no backend
    }
    return () => {
      disposed = true
      clearTimeout(first)
      off?.()
    }
  }, [])

  // Persist the layout (debounced) so the next launch restores it. Skips writes
  // when only runtime status changed (serialized JSON is identical).
  useEffect(() => {
    let last = ""
    let timer: ReturnType<typeof setTimeout> | undefined
    const save = () => {
      if (persistBlocked) return
      const s = useStore.getState()
      const json = serializeToJson({
        sessions: s.sessions,
        tabs: s.tabs,
        activeTabId: s.activeTabId,
        rightPanelWidth: s.rightPanelWidth,
      })
      if (json === last) return
      last = json
      ipc.writeWorkspace(json)
    }
    const unsub = useStore.subscribe((state, prev) => {
      if (
        state.tabs !== prev.tabs ||
        state.sessions !== prev.sessions ||
        state.activeTabId !== prev.activeTabId ||
        state.rightPanelWidth !== prev.rightPanelWidth
      ) {
        clearTimeout(timer)
        timer = setTimeout(save, 600)
      }
    })
    return () => {
      unsub()
      clearTimeout(timer)
    }
  }, [])

  // Re-load settings.json whenever the file changes (GUI or hand-edit). The first load
  // happens in the startup effect, before any terminal spawns.
  useEffect(() => {
    const unlisten = ipc.onSettingsChanged(async () => {
      useStore.getState().setSettings(await loadSettings())
      void ipc.editorInfo().then((e) => useStore.getState().setEditor(e)) // openPath may have changed
    })
    return () => unlisten()
  }, [])

  // Claude session /color + /rename per pane → the pane accent (border + tab icon).
  useEffect(
    () => ipc.onAgentMeta((paneId, meta) => useStore.getState().setAgentMeta(paneId, meta)),
    [],
  )

  // Agents board (M6): fold coalesced hook-event batches into the store's agent tree.
  useEffect(() => {
    const unlisten = ipc.onAgentEvents((events) => {
      useStore.getState().applyAgentEvents(events)
      // A resumed Claude announces itself: SessionStart from that pane → the resume worked.
      for (const ev of events) {
        // Any event proves Claude runs there (after a reload no SessionStart comes) → the
        // prompt returning later clears its icon, even if it crashes without a SessionEnd.
        if (ev.paneId) TerminalManager.agentActive(ev.paneId)
        if (ev.event !== "SessionStart" || !ev.paneId || ev.agentId) continue
        TerminalManager.agentStarted(ev.paneId)
        const r = useStore.getState().resume[ev.paneId]
        // "failed" too: a slow Claude can confirm after the timeout — the late success wins.
        // Only for THIS session: a fresh `claude` the user starts instead isn't a resume.
        if (r?.phase !== "resuming" && r?.phase !== "waiting" && r?.phase !== "failed") continue
        if (ev.sessionId !== r.plan.sessionId) continue
        TerminalManager.resumeSettled(ev.paneId)
        useStore.getState().setResume(ev.paneId, { phase: "resumed", plan: r.plan })
        const paneId = ev.paneId
        setTimeout(() => {
          if (useStore.getState().resume[paneId]?.phase === "resumed") {
            useStore.getState().setResume(paneId, null)
          }
        }, 4000)
      }
      if (import.meta.env.DEV) {
        const g = useStore.getState().agents
        const names = events.map((e) => e.event).join(", ")
        // console.log (Info level) so it isn't hidden by the devtools "Verbose" filter.
        console.log(
          `[agents] +${events.length} [${names}] → ${g.rootIds.length} session(s), ${Object.keys(g.nodes).length} node(s)`,
        )
      }
    })
    return () => unlisten()
  }, [])

  // Paint the resolved theme (CSS vars + native window bg) — only after settings.json has
  // loaded (else the defaults would overwrite main.tsx's cached light theme: a dark flash),
  // and only when the variant actually changes (not on every settings edit / OS toggle).
  useEffect(() => {
    if (!settingsLoaded) return
    applyThemeVars(theme)
    ipc.setWindowBackground(theme.ui.bg)
  }, [theme, settingsLoaded])

  // Push settings (font, cursor, scrollback, renderer, theme palette) to every terminal.
  useEffect(() => {
    if (settingsLoaded) TerminalManager.applySettings(settings)
  }, [settings, theme, settingsLoaded])

  // Follow the OS light/dark preference live (used by appearance: "system").
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return // absent in jsdom/tests
    const mq = window.matchMedia("(prefers-color-scheme: dark)")
    const sync = () => useStore.getState().setSystemDark(mq.matches)
    sync()
    mq.addEventListener?.("change", sync)
    return () => mq.removeEventListener?.("change", sync)
  }, [])

  // Notification permission + window focus tracking (drives focus-aware badges).
  useEffect(() => {
    void ensureNotificationPermission()
    const onFocus = () => useStore.getState().setWindowFocused(true)
    const onBlur = () => useStore.getState().setWindowFocused(false)
    window.addEventListener("focus", onFocus)
    window.addEventListener("blur", onBlur)
    return () => {
      window.removeEventListener("focus", onFocus)
      window.removeEventListener("blur", onBlur)
    }
  }, [])

  // WebGL repair: the GPU glyph atlas / framebuffer can go stale after the app is
  // backgrounded, the display scale / monitor (DPR) changes, or a resize — showing
  // garbled glyphs until a scroll forces a repaint. Automate that repaint on exactly
  // those events; rebuild the atlas when render metrics changed. See GOTCHAS #renderer.
  useEffect(() => {
    const repaint = () => TerminalManager.repairRenderers(false)
    const rebuild = () => TerminalManager.repairRenderers(true)
    const onVisible = () => {
      if (document.visibilityState === "visible") repaint()
    }
    let resizeTimer: ReturnType<typeof setTimeout>
    const onResize = () => {
      clearTimeout(resizeTimer)
      resizeTimer = setTimeout(rebuild, 200) // debounce: rebuild once the drag settles
    }
    // DPR change (monitor swap / OS display scaling / browser zoom) — the media
    // query is pinned to the current devicePixelRatio, so re-arm after each change.
    let dprMq: MediaQueryList | null = null
    const onDpr = () => {
      rebuild()
      armDpr()
    }
    const armDpr = () => {
      if (typeof window.matchMedia !== "function") return // absent in jsdom/tests
      dprMq = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`)
      dprMq.addEventListener?.("change", onDpr, { once: true })
    }
    window.addEventListener("focus", repaint)
    document.addEventListener("visibilitychange", onVisible)
    window.addEventListener("resize", onResize)
    armDpr()
    return () => {
      window.removeEventListener("focus", repaint)
      document.removeEventListener("visibilitychange", onVisible)
      window.removeEventListener("resize", onResize)
      dprMq?.removeEventListener?.("change", onDpr)
      clearTimeout(resizeTimer)
    }
  }, [])

  // Dispose terminals whose sessions have left the store (pane/tab closed).
  useEffect(() => {
    return useStore.subscribe((state, prev) => {
      const current = new Set(Object.keys(state.sessions))
      for (const id of Object.keys(prev.sessions)) {
        if (!current.has(id)) TerminalManager.dispose(id)
      }
    })
  }, [])

  // Keep WebGL on only the on-screen panes: reconcile on tab switch / split /
  // close so background tabs release their GPU context and heavy splits use DOM.
  useEffect(() => {
    return useStore.subscribe((state, prev) => {
      if (state.activeTabId !== prev.activeTabId || state.tabs !== prev.tabs) {
        TerminalManager.reconcileRenderers()
      }
    })
  }, [])

  // Branch + GitHub PR for every terminal (sidebar), and Claude's checkout when it moved (the
  // sidebar's `in` line; also what the status bar / panels follow). Main caches/dedupes, so
  // this is cheap; collapsed sidebar → moved terminals only, no PRs; hidden window → paused.
  // Re-polls soon after a cwd changes (cd / new terminal / Claude moving) or on sidebar show.
  useEffect(() => {
    let stopped = false
    let soon: ReturnType<typeof setTimeout> | undefined
    let lastKey = ""
    let seq = 0 // polls can overlap (a slow gh); only the newest may write
    const poll = async () => {
      const s = useStore.getState()
      if (document.visibilityState === "hidden") return
      const { reqs, polled, inCwd } = planGitPoll(
        Object.values(s.sessions),
        agentWorkDirs(s.agents),
        s.sidebarCollapsed,
      )
      if (reqs.length === 0) {
        if (polled.length) useStore.getState().setPaneGit({}, polled) // still clear stale `in`s
        return
      }
      const mine = ++seq
      const res = await ipc.paneGitInfo(reqs).catch(() => null)
      if (!res || stopped || mine !== seq) return // a newer poll has (or will have) the truth
      const pending = Object.values(res).some((i) => i.prPending)
      for (const i of Object.values(res)) delete i.prPending // transport flag, not state
      const known = useStore.getState().paneGit
      settleInAnswers(res, inCwd, known)
      if (s.sidebarCollapsed) keepPrs(res, known) // no-PR lookups: don't blank the PR lines
      useStore.getState().setPaneGit(res, polled)
      if (pending) pollSoon(1500) // a PR is being fetched in main — pick it up shortly
    }
    const pollSoon = (ms = 400) => {
      clearTimeout(soon)
      soon = setTimeout(() => void poll(), ms)
    }
    const every = setInterval(() => void poll(), 10_000)
    const unsub = useStore.subscribe((state, prev) => {
      if (state.sidebarCollapsed !== prev.sidebarCollapsed && !state.sidebarCollapsed) pollSoon()
      if (state.sessions === prev.sessions && state.agents === prev.agents) return
      const work = agentWorkDirs(state.agents) // memoized: cheap on every hook event
      const key = Object.values(state.sessions)
        .map((x) => `${x.id}=${x.cwd ?? ""}>${work[x.id]?.cwd ?? ""}`)
        .join("|")
      if (key !== lastKey) {
        lastKey = key
        pollSoon()
      }
    })
    return () => {
      stopped = true
      clearInterval(every)
      clearTimeout(soon)
      unsub()
    }
  }, [])

  // Poll git status for the focused session's cwd (feeds status bar + diff panel).
  useEffect(() => {
    if (!activeCwd) {
      useStore.getState().setGit(null)
      return
    }
    // Sequential, never overlapping (a slow call used to pile up behind setInterval), and
    // adaptive: the next poll waits longer when this repo's status is slow (lib/git-poll).
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const poll = () => {
      const t0 = performance.now()
      void ipc
        .gitStatus(activeCwd, getActiveWsl())
        .then((g) => {
          if (!cancelled) useStore.getState().setGit(g)
        })
        .catch(() => {})
        .finally(() => {
          if (!cancelled) timer = setTimeout(poll, nextGitPollDelay(performance.now() - t0))
        })
    }
    poll()
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [activeCwd])

  // Cache $HOME + platform once (home-relative labels; OS-specific menu labels).
  useEffect(() => {
    void ipc.platformInfo().then((i) => {
      useStore.getState().setHome(i.home)
      useStore.getState().setPlatform(i.platform)
      useStore.getState().setProfile(i.profile)
    })
    void ipc.editorInfo().then((e) => useStore.getState().setEditor(e))
  }, [])

  // Load-test mode (MINMUX_PERF=1): run the perf suite once, then report.
  useEffect(() => {
    void ipc.perfMode().then((on) => {
      if (on) void import("./lib/perf").then((m) => m.runPerfSuite())
    })
  }, [])

  // Surface drag lifecycle. A drag can end without reaching a target (Esc, dropped
  // outside); and if the source tab remounts mid-drag its dragend goes to a detached node
  // and never reaches window — so while dragging, the first mouse move with no button held
  // also ends it. Whenever a drag ends, keyboard focus returns to the focused terminal
  // (the tab's mousedown blurred it and the drag swallowed the pane's mouseup refocus).
  useEffect(() => {
    const end = () => {
      if (useStore.getState().dragging) useStore.getState().setDragging(null)
    }
    const onMove = (e: MouseEvent) => {
      if (e.buttons === 0) end()
    }
    const unsub = useStore.subscribe((state, prev) => {
      if (!prev.dragging && state.dragging) window.addEventListener("mousemove", onMove)
      if (prev.dragging && !state.dragging) {
        window.removeEventListener("mousemove", onMove)
        requestAnimationFrame(() => {
          const s = useStore.getState()
          const sid = s.tabs.find((t) => t.id === s.activeTabId)?.activeSessionId
          if (sid) TerminalManager.focus(sid)
        })
      }
    })
    window.addEventListener("dragend", end)
    window.addEventListener("drop", end)
    return () => {
      unsub()
      window.removeEventListener("mousemove", onMove)
      window.removeEventListener("dragend", end)
      window.removeEventListener("drop", end)
    }
  }, [])

  // Global shortcuts: ⌘K/Ctrl-K = command palette; ⌘F (mac) / Ctrl+Shift+F = find;
  // ⌘T (mac) / Ctrl+Shift+T = new terminal in the focused pane. Plain Ctrl+F / Ctrl+T
  // are left for the shell (readline forward-char / transpose-chars).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase()
      // The close confirm is modal: no palette / find / new terminal behind it.
      if (useStore.getState().closeConfirm) return
      if (appShortcut(e, { isMac }) === "new-surface") {
        e.preventDefault()
        if (e.repeat) return // holding the chord must not spawn a shell per key-repeat
        const s = useStore.getState()
        // Not from an overlay or a text field (palette, settings, rename, root path): a
        // new terminal would steal their focus. xterm's own textarea is the exception.
        const t = e.target as HTMLElement | null
        const typing = t?.closest?.("input, select, textarea:not(.xterm-helper-textarea)")
        if (s.paletteOpen || s.settingsOpen || s.preview || typing) return
        s.newSurface(resolveDefaultShell(s.shells, s.settings.defaultShell))
      } else if ((e.metaKey || e.ctrlKey) && k === "k") {
        e.preventDefault()
        const s = useStore.getState()
        s.setPaletteOpen(!s.paletteOpen)
      } else if ((e.metaKey && k === "f") || (e.ctrlKey && e.shiftKey && k === "f")) {
        e.preventDefault()
        const s = useStore.getState()
        s.setSearchOpen(!s.searchOpen)
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])

  const activeTab = tabs.find((t) => t.id === activeTabId) ?? null

  // Drive the panel width via a CSS var so a drag can update it without re-rendering
  // the App subtree each frame (the resizer sets --rpw live; the store commits on release).
  useLayoutEffect(() => {
    document.documentElement.style.setProperty("--rpw", `${rightPanelWidth}px`)
  }, [rightPanelWidth])

  // Keep the "≤60% of the window" guarantee outside an active drag too: re-clamp on
  // mount (restore may carry a width from a larger monitor) and whenever the window resizes.
  useEffect(() => {
    const reclamp = () =>
      useStore
        .getState()
        .setRightPanelWidth(useStore.getState().rightPanelWidth, window.innerWidth * 0.6)
    reclamp()
    window.addEventListener("resize", reclamp)
    return () => window.removeEventListener("resize", reclamp)
  }, [])

  return (
    <div className="app">
      <TopBar />
      <div className="body">
        {!sidebarCollapsed && <Sidebar />}
        <div className="content">
          {activeTab ? (
            <PaneLayout key={activeTab.id} node={activeTab.root} tabId={activeTab.id} />
          ) : (
            <div className="empty">No sessions — open a tab.</div>
          )}
          {searchOpen && <SearchBar />}
        </div>
        {rightView && (
          <div className="rightpanel">
            <RightPanelResizer />
            {rightView === "files" && <FilesPanel />}
            {rightView === "changes" && <DiffPanel />}
            {rightView === "agents" && <AgentsPanel />}
          </div>
        )}
      </div>
      <StatusBar />
      {paletteOpen && <CommandPalette />}
      {hostPickerOpen && <HostPicker />}
      {settingsOpen && <SettingsPanel />}
      <FilePreview />
      <CloseConfirmDialog />
    </div>
  )
}

export default App
