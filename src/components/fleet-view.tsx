// The Fleet tab's view (docs/design/FLEET_GRAPH.md, "The graph"): the repos with a live agent
// session on a ring; one opened as a radial tree (PRs, their agents, sub-agents) with the others
// docked in a strip, and a side panel for the selection. Cards are DOM, placed in world
// coordinates (lib/fleet-layout) on one layer; a camera (the world point in the middle) pans it
// with a transform: no native scrolling. The edges are one viewport-sized 2D canvas under the
// cards. Static here: the motion step turns it.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { ArrowSquareOut, GitBranch, Graph } from "@phosphor-icons/react"
import { useStore, activeTheme } from "../store"
import { useFleetModel } from "./use-fleet-data"
import {
  FLEET,
  clampCamera,
  nodeId,
  openLayout,
  overviewLayout,
  relax,
  toScreen,
  unionBox,
  bounds,
  type Camera,
  type FleetNode,
} from "../lib/fleet-layout"
import { DETACHED, type FleetAgent, type FleetPr, type FleetRepo } from "../lib/fleet-model"
import { cardLook } from "../lib/pr-graph"
import { AGENT_STATUS_UI } from "../lib/agent-status-ui"
import { agentColor, agentInfo } from "../lib/agent-kinds"
import { agentIcon } from "./agent-icon"
import { ipc } from "../lib/ipc"
import { TerminalManager } from "../terminal/terminal-manager"

type Selection = { kind: "repo"; key: string } | { kind: "agent"; id: string } | null

/** What a node stands for: its repo and, by kind, its PR, branch, agent or sub-agent. */
interface NodeInfo {
  repo: FleetRepo
  pr?: FleetPr
  agent?: FleetAgent
  branch?: string
  sub?: FleetAgent["subs"][number]
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`
const shortName = (label: string) => (label.split("/").pop() ?? label).toUpperCase()

/** What a PR card says under its title, and its tone. */
function prStatus(p: FleetPr): { word: string; cls: string } {
  if (!p.row) return { word: p.state === "draft" ? "draft" : "open", cls: "" }
  const look = cardLook(p.row)
  const word =
    p.row.merge === "conflicts"
      ? "conflicts"
      : p.row.ci === "failure"
        ? "CI failing"
        : p.row.review === "changes"
          ? "changes requested"
          : p.row.ci === "pending"
            ? "CI running"
            : look.approved
              ? "✓ approved"
              : look.draft
                ? "draft"
                : "ready"
  return { word, cls: look.tone ?? (look.approved ? "ok" : "") }
}

const agentName = (a: FleetAgent) => a.name || agentInfo(a.kind).label
const agentDoing = (a: FleetAgent) =>
  a.status === "waiting"
    ? "needs you"
    : a.status === "working"
      ? a.currentTool
        ? `running ${a.currentTool}`
        : "working"
      : AGENT_STATUS_UI[a.status].word

const goToPane = (paneId: string) => {
  useStore.getState().focusSession(paneId)
  requestAnimationFrame(() => TerminalManager.focus(paneId))
}

export function FleetView() {
  // The keyboard comes here when the view shows (the parked terminals are inert).
  const ref = useRef<HTMLDivElement>(null)
  const repos = useFleetModel()
  const [openKey, setOpenKey] = useState<string | null>(null)
  const [sel, setSel] = useState<Selection>(null)
  // What's open is also held by its checkout roots: a folder's key becomes owner/name once the
  // repo lookup answers, and the open repo follows it. Worked out here, in render, so the old key
  // never reaches the panel or the highlight.
  const openRoots = useRef<string[]>([])
  const open = openKey
    ? (repos.find((r) => r.key === openKey) ??
      repos.find((r) => r.roots.some((x) => openRoots.current.includes(x))) ??
      null)
    : null
  const shownSel: Selection =
    sel?.kind === "repo" && open && sel.key === openKey ? { kind: "repo", key: open.key } : sel
  useEffect(() => {
    if (open) openRoots.current = open.roots
    if (openKey && !open) {
      // It left the model (its last agent ended): closed; it doesn't reopen by itself later.
      openRoots.current = []
      setOpenKey(null)
      setSel(null)
    } else if (open && open.key !== openKey) {
      setOpenKey(open.key)
      setSel((s) => (s?.kind === "repo" && s.key === openKey ? { kind: "repo", key: open.key } : s))
    }
  }, [openKey, open])

  const nodes = useMemo(
    () => (open ? relax(openLayout(open)) : overviewLayout(repos)),
    [open, repos],
  )

  const lookup = useMemo(() => {
    const m = new Map<string, NodeInfo>()
    for (const r of repos) {
      m.set(nodeId.root(r.key), { repo: r })
      const agentIn = (a: FleetAgent) => {
        m.set(nodeId.agent(a.id), { repo: r, agent: a })
        for (const s of a.subs) m.set(nodeId.sub(s.id), { repo: r, agent: a, sub: s })
      }
      for (const p of r.prs) {
        m.set(nodeId.pr(p.url), { repo: r, pr: p })
        p.agents.forEach(agentIn)
      }
      for (const b of r.branches) {
        m.set(nodeId.branch(r.key, b.name), { repo: r, branch: b.name })
        b.agents.forEach(agentIn)
      }
      r.agents.forEach(agentIn)
    }
    return m
  }, [repos])

  // The camera: the world point in the middle of the view. It lives in a ref and is written to
  // the cards' layer as a transform (and the canvas redrawn) on a frame: panning renders nothing.
  const viewport = useRef<HTMLDivElement>(null)
  // (the keyboard lands on the graph's viewport: arrows pan it at once)
  useEffect(() => viewport.current?.focus(), [])
  const layer = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const cam = useRef<Camera>({ x: FLEET.cx, y: FLEET.cy })
  const nodesRef = useRef(nodes)
  nodesRef.current = nodes
  const drawRef = useRef<() => void>(() => {})
  const frame = useRef(0)
  const apply = useCallback(() => {
    cancelAnimationFrame(frame.current)
    frame.current = requestAnimationFrame(() => {
      const el = viewport.current
      if (!el) return
      const o = toScreen({ x: 0, y: 0 }, cam.current, el.clientWidth, el.clientHeight)
      const tx = Math.round(o.x)
      const ty = Math.round(o.y)
      if (layer.current) layer.current.style.transform = `translate3d(${tx}px, ${ty}px, 0)`
      drawRef.current()
    })
  }, [])
  const glide = useRef(0)
  const moveTo = useCallback(
    (to: Camera, smooth: boolean) => {
      cancelAnimationFrame(glide.current)
      if (!smooth || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
        cam.current = to
        apply()
        return
      }
      const from = cam.current
      let t0 = -1
      const step = (t: number) => {
        if (t0 < 0) t0 = t // (the first frame's own time: never a step backwards)
        const k = Math.min(1, Math.max(0, (t - t0) / 320))
        const e = 1 - (1 - k) ** 3 // ease out
        cam.current = { x: from.x + (to.x - from.x) * e, y: from.y + (to.y - from.y) * e }
        apply()
        if (k < 1) glide.current = requestAnimationFrame(step)
      }
      glide.current = requestAnimationFrame(step)
    },
    [apply],
  )

  const moveToRef = useRef(moveTo)
  moveToRef.current = moveTo

  // Each open or close centres its view once; a layout change keeps the camera where it is (over
  // the graph): nothing slides under the user.
  const [view, setView] = useState(0)
  const viewId = `${view}:${open ? "open" : "all"}`
  const shownView = useRef<string | null>(null)
  // The camera's bounds: the view's extent, which only grows while it shows (a card that goes
  // away never pulls the camera in, so nothing moves under the user).
  const extent = useRef<ReturnType<typeof bounds> | null>(null)
  useLayoutEffect(() => {
    if (shownView.current !== viewId) {
      const first = shownView.current === null
      shownView.current = viewId
      extent.current = bounds(nodes)
      moveTo({ x: FLEET.cx, y: FLEET.cy }, !first && !!open)
    } else {
      extent.current = unionBox(extent.current, bounds(nodes))
      apply()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `open` only picks the glide
  }, [viewId, nodes, moveTo, apply])

  const toggle = useCallback(
    (key: string) => {
      const closing = openKey === key
      openRoots.current = closing ? [] : (repos.find((r) => r.key === key)?.roots ?? [])
      setOpenKey(closing ? null : key)
      setSel(closing ? null : { kind: "repo", key })
      setView((v) => v + 1)
    },
    [openKey, repos],
  )
  const closeAll = useCallback(() => {
    openRoots.current = []
    setOpenKey(null)
    setSel(null)
    setView((v) => v + 1)
  }, [])

  // The edges: one canvas the size of the viewport, drawn through the camera.
  const selectedAgent = shownSel?.kind === "agent" ? shownSel.id : null
  const scheme = useStore((s) => activeTheme(s).scheme)
  // The theme's colours, from the theme itself (its CSS variables may not be applied yet).
  const ui = useStore((s) => activeTheme(s).ui)
  const draw = useCallback(() => {
    const c = canvas.current
    const el = viewport.current
    const ctx = c?.getContext?.("2d")
    if (!c || !el || !ctx) return
    const dpr = window.devicePixelRatio || 1
    const w = el.clientWidth
    const h = el.clientHeight
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
      c.width = Math.round(w * dpr)
      c.height = Math.round(h * dpr)
      c.style.width = `${w}px`
      c.style.height = `${h}px`
    }
    const o = toScreen({ x: 0, y: 0 }, cam.current, w, h)
    const tx = Math.round(o.x)
    const ty = Math.round(o.y)
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, c.width, c.height)
    ctx.setTransform(dpr, 0, 0, dpr, tx * dpr, ty * dpr)
    const { border2: faint, red, accent } = ui
    const ns = nodesRef.current
    const byId = new Map(ns.map((n) => [n.id, n]))
    // The selected agent's way to its repo, drawn green.
    const path = new Set<string>()
    for (
      let id = selectedAgent ? nodeId.agent(selectedAgent) : undefined;
      id;
      id = byId.get(id)?.parent
    )
      path.add(id)
    for (const n of ns) {
      const p = n.parent && byId.get(n.parent)
      if (!p) continue
      const info = lookup.get(n.id)
      const on = path.has(n.id) && path.has(p.id)
      const blocked = info?.pr?.row && cardLook(info.pr.row).tone === "red"
      ctx.beginPath()
      ctx.moveTo(p.x, p.y)
      ctx.lineTo(n.x, n.y)
      ctx.setLineDash(n.kind === "sub" || n.kind === "branch" ? [4, 5] : [])
      ctx.lineWidth = on ? 2.5 : 1.5
      ctx.strokeStyle = on
        ? accent
        : n.kind === "agent" && info?.agent
          ? (agentColor(info.agent.kind, scheme) ?? faint)
          : blocked
            ? red
            : faint
      ctx.globalAlpha = on ? 1 : n.kind === "agent" && info?.agent?.status === "idle" ? 0.35 : 0.7
      ctx.stroke()
    }
    ctx.globalAlpha = 1
  }, [lookup, selectedAgent, scheme, ui])
  drawRef.current = draw
  useEffect(() => apply(), [draw, nodes, apply])

  // Panning: the wheel / trackpad, or dragging empty space. A resize needs nothing: the camera is
  // the middle, so the graph stays centred on it.
  useEffect(() => {
    const el = viewport.current
    if (!el) return
    const pan = (dx: number, dy: number) => {
      cancelAnimationFrame(glide.current) // the user takes over from an opening's glide
      cam.current = clampCamera(
        { x: cam.current.x + dx, y: cam.current.y + dy },
        nodesRef.current,
        extent.current ?? undefined,
      )
      apply()
    }
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      if (e.ctrlKey) return // a pinch (or ctrl+wheel): no zoom yet, and never a pan
      // (lines and pages in pixels; shift turns a mouse wheel sideways)
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? el.clientHeight : 1
      const dx = e.deltaX || (e.shiftKey ? e.deltaY : 0)
      const dy = e.shiftKey && !e.deltaX ? 0 : e.deltaY
      pan(dx * unit, dy * unit)
    }
    // The keyboard pans too: arrows a step, Page Up/Down a screen (not from a text field).
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest("input, textarea, select")) return
      const step = 80
      const page = el.clientHeight * 0.8
      const d: Record<string, [number, number]> = {
        ArrowLeft: [-step, 0],
        ArrowRight: [step, 0],
        ArrowUp: [0, -step],
        ArrowDown: [0, step],
        PageUp: [0, -page],
        PageDown: [0, page],
      }
      const m = d[e.key]
      if (!m) return
      e.preventDefault()
      pan(m[0], m[1])
    }
    let drag: { x: number; y: number; id: number } | null = null
    const onDown = (e: PointerEvent) => {
      if (e.button !== 0 || (e.target as HTMLElement).closest("button, .fleet-card")) return
      e.preventDefault() // no text selection following the drag
      drag = { x: e.clientX, y: e.clientY, id: e.pointerId }
      el.setPointerCapture?.(e.pointerId)
      el.classList.add("panning")
    }
    const onMove = (e: PointerEvent) => {
      if (!drag || e.pointerId !== drag.id) return
      if ((e.buttons & 1) === 0) return end() // the button came up where we didn't hear it
      pan(drag.x - e.clientX, drag.y - e.clientY)
      drag = { ...drag, x: e.clientX, y: e.clientY }
    }
    const end = () => {
      drag = null
      el.classList.remove("panning")
    }
    const onUp = (e: PointerEvent) => {
      if (drag && e.pointerId === drag.id) end()
    }
    // A card the keyboard (or anything else) focuses comes into view: the camera glides to it.
    const onFocus = (e: FocusEvent) => {
      // (keyboard focus only: a click focuses its card too, and gliding then would move the
      // card from under a double-click)
      const t = e.target as HTMLElement
      if (!t.matches?.(":focus-visible")) return
      const id = t.closest<HTMLElement>("[data-node]")?.dataset.node
      const n = id ? nodesRef.current.find((x) => x.id === id) : undefined
      if (!n) return
      const { x: sx, y: sy } = toScreen(n, cam.current, el.clientWidth, el.clientHeight)
      const margin = 24
      const inside =
        sx - n.w / 2 >= margin &&
        sx + n.w / 2 <= el.clientWidth - margin &&
        sy - n.h / 2 >= margin &&
        sy + n.h / 2 <= el.clientHeight - margin
      if (!inside) moveToRef.current({ x: n.x, y: n.y }, true)
    }
    el.addEventListener("focusin", onFocus)
    el.addEventListener("keydown", onKey)
    el.addEventListener("lostpointercapture", end)
    el.addEventListener("wheel", onWheel, { passive: false })
    el.addEventListener("pointerdown", onDown)
    el.addEventListener("pointermove", onMove)
    el.addEventListener("pointerup", onUp)
    el.addEventListener("pointercancel", onUp)
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => apply()) : null
    ro?.observe(el)
    return () => {
      cancelAnimationFrame(frame.current)
      cancelAnimationFrame(glide.current)
      el.removeEventListener("focusin", onFocus)
      el.removeEventListener("keydown", onKey)
      el.removeEventListener("lostpointercapture", end)
      el.removeEventListener("wheel", onWheel)
      el.removeEventListener("pointerdown", onDown)
      el.removeEventListener("pointermove", onMove)
      el.removeEventListener("pointerup", onUp)
      el.removeEventListener("pointercancel", onUp)
      ro?.disconnect()
    }
  }, [apply])

  const docked = open ? repos.filter((r) => r.key !== open.key) : []
  return (
    <div className="fleet-view" ref={ref} tabIndex={-1}>
      <div className="fleet-graph">
        <canvas className="fleet-edges" ref={canvas} aria-hidden="true" />
        <div
          className="fleet-viewport"
          ref={viewport}
          tabIndex={0}
          aria-label="Fleet graph: arrows and Page Up/Down pan it"
        >
          <div className="fleet-layer" ref={layer}>
            {nodes.map((n) => (
              <FleetCard
                key={n.id}
                node={n}
                info={lookup.get(n.id)}
                open={!!open}
                selected={
                  (shownSel?.kind === "agent" && n.id === nodeId.agent(shownSel.id)) ||
                  (shownSel?.kind === "repo" && n.id === nodeId.root(shownSel.key))
                }
                onRoot={toggle}
                onAgent={(id) => setSel({ kind: "agent", id })}
              />
            ))}
          </div>
        </div>
        {repos.length === 0 && (
          <div className="empty fleet-empty">
            <div>
              <Graph size={28} weight="duotone" />
              <p>No agent is working in a repo right now.</p>
            </div>
          </div>
        )}
        {docked.length > 0 && (
          <div className="fleet-dock" aria-label="Other repos">
            {docked.map((r) => (
              <button
                key={r.key}
                className="fleet-dock-repo"
                onClick={() => toggle(r.key)}
                title={`Open ${r.label}`}
              >
                <span className="fleet-dock-dot">{shortName(r.label).charAt(0)}</span>
                <span className="fleet-dock-name">{r.label}</span>
                <RepoCounts repo={r} />
              </button>
            ))}
          </div>
        )}
      </div>
      <FleetPanel
        repos={repos}
        open={open}
        sel={shownSel}
        agentOf={(id) => lookup.get(nodeId.agent(id))}
        onRepo={(key) => {
          if (openKey !== key) toggle(key)
          else setSel({ kind: "repo", key })
        }}
        onAgent={(id) => setSel({ kind: "agent", id })}
        onAll={closeAll}
      />
    </div>
  )
}

function RepoCounts({ repo }: { repo: FleetRepo }) {
  const { working, waiting } = repo.counts
  return (
    <span className="fleet-counts">
      {working > 0 && <span className="ok">● {working} working</span>}
      {waiting > 0 && <span className="warn">● {waiting} need you</span>}
      {!working && !waiting && <span>{plural(repo.counts.agents, "agent")}</span>}
    </span>
  )
}

function FleetCard(props: {
  node: FleetNode
  info: NodeInfo | undefined
  open: boolean
  selected: boolean
  onRoot: (key: string) => void
  onAgent: (id: string) => void
}) {
  const { node: n, info, open, selected } = props
  if (!info) return null
  const style = { left: n.x - n.w / 2, top: n.y - n.h / 2, width: n.w, height: n.h }
  if (n.kind === "root") {
    const r = info.repo
    return (
      <>
        <button
          className={`fleet-root${open ? " open" : ""}${selected ? " sel" : ""}`}
          style={style}
          data-node={n.id}
          aria-label={`${open ? "Close" : "Open"} ${r.label}`}
          aria-expanded={open}
          onClick={() => props.onRoot(r.key)}
        >
          {shortName(r.label).slice(0, 10)}
        </button>
        {!open && (
          <div className="fleet-root-label" style={{ left: n.x - 120, top: n.y + n.h / 2 + 12 }}>
            <span className="one">
              {r.label}
              {r.defaultBranch && <span className="faint"> ⑂ {r.defaultBranch}</span>}
            </span>
            <span className="one faint">
              {plural(r.counts.prs, "PR")} · {plural(r.counts.agents, "agent")}
            </span>
            <RepoCounts repo={r} />
          </div>
        )}
      </>
    )
  }
  if (n.kind === "pr" && info.pr) {
    const p = info.pr
    const st = prStatus(p)
    return (
      <div
        className={`fleet-card fleet-pr${st.cls === "ok" ? "" : ` ${st.cls}`}${p.state === "draft" ? " draft" : ""}`}
        style={style}
        data-node={n.id}
      >
        <span className="one">
          <span className="faint">#{p.number}</span> <b>{p.row?.title ?? ""}</b>
        </span>
        <span className={`one fleet-st ${st.cls}`}>{st.word}</span>
        <button
          className="fleet-link"
          title="Open on GitHub"
          aria-label={`Open #${p.number} on GitHub`}
          onClick={() => ipc.openExternal(p.url)}
        >
          <ArrowSquareOut size={11} />
        </button>
      </div>
    )
  }
  if (n.kind === "branch") {
    return (
      <div className="fleet-card fleet-branch" style={style}>
        <GitBranch size={12} />
        <span className="one">
          {info.branch === DETACHED ? "detached HEAD" : info.branch}{" "}
          <span className="faint">· no PR</span>
        </span>
      </div>
    )
  }
  if (n.kind === "sub" && info.sub) {
    const st = AGENT_STATUS_UI[info.sub.status]
    return (
      <div className="fleet-card fleet-sub" style={style}>
        <span className={`dot sm ${st.cls}`} />
        <span className="one">
          {info.sub.type} <span className="faint">· {st.word}</span>
        </span>
      </div>
    )
  }
  if (n.kind === "agent" && info.agent) {
    const a = info.agent
    const Icon = agentIcon(a.kind)
    const st = AGENT_STATUS_UI[a.status]
    return (
      <button
        className={`fleet-card fleet-agent ${a.status}${selected ? " sel" : ""}`}
        style={style}
        data-node={n.id}
        aria-label={`${agentInfo(a.kind).label} agent ${agentName(a)}, ${st.word}`}
        onClick={() => props.onAgent(a.id)}
        onDoubleClick={() => goToPane(a.paneId)}
      >
        <span className="one">
          <span className="fleet-kind">
            <Icon size={13} />
          </span>{" "}
          <b>{agentName(a)}</b>{" "}
          <span className="faint">· {a.subs.length ? plural(a.subs.length, "sub") : st.word}</span>
        </span>
        <span className="one">
          <span className={`dot sm ${st.cls}`} />{" "}
          <span className={a.status === "waiting" ? "warn" : "dim"}>{agentDoing(a)}</span>
        </span>
      </button>
    )
  }
  return null
}

function FleetPanel(props: {
  repos: FleetRepo[]
  open: FleetRepo | null
  sel: Selection
  agentOf: (id: string) => NodeInfo | undefined
  onRepo: (key: string) => void
  onAgent: (id: string) => void
  onAll: () => void
}) {
  const { repos, sel } = props
  const agent = sel?.kind === "agent" ? props.agentOf(sel.id) : undefined
  const repo =
    sel?.kind === "repo"
      ? repos.find((r) => r.key === sel.key)
      : (agent?.repo ?? props.open ?? undefined)

  if (agent?.agent) {
    const a = agent.agent
    const pr = agent.repo.prs.find((p) => p.agents.some((x) => x.id === a.id))
    const st = AGENT_STATUS_UI[a.status]
    const ctx = a.tokens?.window ? Math.round((a.tokens.context / a.tokens.window) * 100) : null
    return (
      <aside className="fleet-panel" aria-label="Agent">
        <button className="fleet-back" onClick={() => props.onRepo(agent.repo.key)}>
          ← {agent.repo.label}
          {pr ? ` › #${pr.number}` : ""}
        </button>
        <h2 className="one">{agentName(a)}</h2>
        <div className="fleet-panel-row">
          <span className={`dot ${st.cls}`} /> {agentInfo(a.kind).label} · {agentDoing(a)}
        </div>
        <button className="btn primary" onClick={() => goToPane(a.paneId)}>
          Go to pane
        </button>
        <dl className="fleet-facts">
          <dt>PR</dt>
          <dd className="one">{pr ? `#${pr.number} ${pr.row?.title ?? ""}` : "none"}</dd>
          <dt>branch</dt>
          <dd className="one">{a.branch ?? "—"}</dd>
          {a.cwd && (
            <>
              <dt>cwd</dt>
              <dd className="one">{a.cwd}</dd>
            </>
          )}
          {a.tokens && (
            <>
              <dt>context</dt>
              <dd>
                {Math.round(a.tokens.context / 1000)}k
                {a.tokens.window ? ` / ${Math.round(a.tokens.window / 1000)}k` : ""}
                {ctx !== null && (
                  <span className="fleet-meter">
                    <span
                      style={{ width: `${Math.min(100, ctx)}%` }}
                      className={ctx > 80 ? "warn" : ""}
                    />
                  </span>
                )}
              </dd>
            </>
          )}
        </dl>
        <h3>Sub-agents · {a.subs.length}</h3>
        {a.subs.length ? (
          a.subs.map((s) => (
            <div key={s.id} className="fleet-panel-row">
              <span className={`dot sm ${AGENT_STATUS_UI[s.status].cls}`} /> {s.type}{" "}
              <span className="faint">· {AGENT_STATUS_UI[s.status].word}</span>
            </div>
          ))
        ) : (
          <div className="faint">none</div>
        )}
      </aside>
    )
  }

  if (repo) {
    const agents = [
      ...repo.prs.flatMap((p) => p.agents),
      ...repo.branches.flatMap((b) => b.agents),
      ...repo.agents,
    ]
    return (
      <aside className="fleet-panel" aria-label="Repo">
        <button className="fleet-back" onClick={props.onAll}>
          ← all repos
        </button>
        <h2 className="one">{repo.label}</h2>
        <div className="faint">
          {repo.defaultBranch ? `⑂ ${repo.defaultBranch} · ` : ""}
          {plural(repo.counts.prs, "PR")} · {plural(repo.counts.agents, "agent")}
        </div>
        {repo.repo && (
          <button
            className="btn"
            onClick={() => ipc.openExternal(`https://github.com/${repo.repo}`)}
          >
            Open on GitHub ↗
          </button>
        )}
        <h3>Pull requests</h3>
        {repo.prs.length ? (
          repo.prs.map((p) => {
            const st = prStatus(p)
            return (
              <div key={p.url} className="fleet-panel-row">
                <span className="faint">#{p.number}</span>{" "}
                <span className="one">{p.row?.title ?? ""}</span>{" "}
                <span className={`fleet-st ${st.cls}`}>{st.word}</span>
              </div>
            )
          })
        ) : (
          <div className="faint">none open</div>
        )}
        <h3>Agent sessions</h3>
        {agents.map((a) => {
          const Icon = agentIcon(a.kind)
          return (
            <button
              key={a.id}
              className="fleet-panel-row fleet-pick"
              onClick={() => props.onAgent(a.id)}
            >
              <Icon size={13} /> <span className="one">{agentName(a)}</span>{" "}
              <span className="faint">· {agentDoing(a)}</span>
            </button>
          )
        })}
      </aside>
    )
  }

  return (
    <aside className="fleet-panel" aria-label="Repos">
      <h3>Repos · {repos.length}</h3>
      {repos.map((r) => (
        <button key={r.key} className="fleet-repo-row" onClick={() => props.onRepo(r.key)}>
          <b className="one">{r.label}</b>
          <span className="faint">
            {plural(r.counts.prs, "PR")} · {plural(r.counts.agents, "agent")}
          </span>
          <RepoCounts repo={r} />
        </button>
      ))}
      <div className="fleet-hint faint">
        Repos with a live agent session. Open one to see its PRs and the agents on them.
      </div>
    </aside>
  )
}
