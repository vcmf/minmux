// The Fleet tab's view (docs/design/FLEET_GRAPH.md, "The graph"): the repos with a live agent
// session on a ring; one opened as a radial tree (PRs, their agents, sub-agents) with the others
// docked in a strip, and a side panel for the selection. Cards are DOM, placed in world
// coordinates (lib/fleet-layout) on one layer; a camera (the world point in the middle) pans it
// with a transform: no native scrolling. The edges are one viewport-sized 2D canvas under the
// cards. The open repo turns slowly while the mouse is still (lib/fleet-motion).
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { Graph, Minus, Plus, PushPinSlash } from "@phosphor-icons/react"
import { useStore, activeTheme } from "../store"
import { useFleetModel } from "./use-fleet-data"
import {
  FLEET,
  clampCamera,
  nodeId,
  unionBox,
  bounds,
  cubicAt,
  linkCurve,
  type Camera,
  type FleetNode,
} from "../lib/fleet-layout"
import { agentsIn, fleetAgentsOf, type FleetAgent, type FleetRepo } from "../lib/fleet-model"
import { cardLook } from "../lib/pr-graph"
import { agentColor } from "../lib/agent-kinds"
import {
  ZOOM_MAX,
  ZOOM_MIN,
  cardInView,
  clampZoom,
  keyPan,
  keyZoom,
  wheelPan,
  wheelZoom,
  zoomAt,
} from "../lib/fleet-camera"
import {
  FRAME_MS,
  GROW_MS,
  KEY_RAD,
  IDLE_MS,
  TURN_RAD_PER_MS,
  dotAt,
  moving,
  turning,
  type MotionState,
} from "../lib/fleet-motion"

import { type Selection, type NodeInfo, RepoCounts, FleetCard, FleetPanel } from "./fleet-cards"
import { FleetInventory } from "./fleet-inventory"
import { useFleetLayout } from "./use-fleet-layout"

export function FleetView() {
  const repos = useFleetModel()
  const [openKey, setOpenKey] = useState<string | null>(null)
  const [sel, setSel] = useState<Selection>(null)
  // The graph, or the inventory over it (the graph stays mounted: its camera, open repo and pins
  // keep; its motion pauses). A row picked there marks the open sessions that used it.
  const [mode, setMode] = useState<"graph" | "inventory">("graph")
  const modeRef = useRef(mode)
  modeRef.current = mode
  const [marked, setMarked] = useState<{ ids: Set<string>; label: string; repos: number } | null>(
    null,
  )
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
  // Positions: the layout, its turn and grow-out, and the pins (use-fleet-layout).
  const {
    pins,
    pinsRev,
    clearPins,
    pinCount,
    setPinCount,
    setPinVersion,
    theta,
    openedAt,
    grewOut,
    reduced,
    layoutNow,
  } = useFleetLayout()
  useEffect(() => {
    if (open) openRoots.current = open.roots
    if (openKey && !open) {
      // It left the model (its last agent ended): closed; it doesn't reopen by itself later.
      openRoots.current = []
      setOpenKey(null)
      setSel(null)
      clearPins()
      setPinCount(0)
    } else if (open && open.key !== openKey) {
      setOpenKey(open.key)
      setSel((s) => (s?.kind === "repo" && s.key === openKey ? { kind: "repo", key: open.key } : s))
    }
  }, [openKey, open, clearPins, setPinCount])

  const nodes = layoutNow(open, repos, performance.now())

  const lookup = useMemo(() => {
    const m = new Map<string, NodeInfo>()
    // (an agent in two repos: the open one's card is the one shown, so it's looked up last)
    for (const r of open ? [...repos.filter((x) => x !== open), open] : repos) {
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
        m.set(nodeId.branch(r.key, b.name), { repo: r, branch: b.name, branchNode: b })
        b.agents.forEach(agentIn)
      }
      r.agents.forEach(agentIn)
    }
    return m
  }, [repos, open])

  // The camera: the world point in the middle of the view. It lives in a ref and is written to
  // the cards' layer as a transform (and the canvas redrawn) on a frame: panning renders nothing.
  const viewport = useRef<HTMLDivElement>(null)
  // The keyboard lands on the graph's viewport when the view shows (the parked terminals are
  // inert): arrows pan it at once.
  useEffect(() => viewport.current?.focus({ focusVisible: false } as FocusOptions), [])
  const layer = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const cam = useRef<Camera>({ x: FLEET.cx, y: FLEET.cy })
  const nodesRef = useRef(nodes)
  nodesRef.current = nodes
  const drawRef = useRef<() => void>(() => {})
  const frame = useRef(0)
  // The zoom: the layer scaled about its top left, the edges drawn at the same scale.
  const zoom = useRef(1)
  const zoomFrame = useRef(0)
  // The zoom controls are written to directly (their level, which ends are off): a pinch's
  // many steps render nothing.
  const zoomBar = useRef<HTMLDivElement>(null)
  const showZoom = () => {
    const bar = zoomBar.current
    if (!bar) return
    const z = zoom.current
    const [out, level, inn] = bar.querySelectorAll("button")
    if (level) level.textContent = `${Math.round(z * 100)}%`
    if (out) (out as HTMLButtonElement).disabled = z <= ZOOM_MIN
    if (inn) (inn as HTMLButtonElement).disabled = z >= ZOOM_MAX
  }
  /** Where the world's origin lands on screen, and the scale, for a view this size. */
  const origin = (w: number, h: number) => {
    const z = zoom.current
    return {
      tx: Math.round(w / 2 - cam.current.x * z),
      ty: Math.round(h / 2 - cam.current.y * z),
      z,
    }
  }
  const apply = useCallback(() => {
    cancelAnimationFrame(frame.current)
    frame.current = requestAnimationFrame(() => {
      const el = viewport.current
      if (!el) return
      const { tx, ty, z } = origin(el.clientWidth, el.clientHeight)
      if (layer.current)
        layer.current.style.transform = `translate3d(${tx}px, ${ty}px, 0) scale(${z})`
      drawRef.current()
    })
  }, [])
  const glide = useRef(0)
  const moveTo = useCallback(
    (to: Camera, smooth: boolean, done?: () => void) => {
      cancelAnimationFrame(glide.current)
      if (!smooth || window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches) {
        cam.current = to
        apply()
        done?.()
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
        else done?.()
      }
      glide.current = requestAnimationFrame(step)
    },
    [apply],
  )

  /** Zoom to `nz` about a point of the view (its middle when absent). */
  const zoomTo = useCallback(
    (nz: number, at?: { x: number; y: number }) => {
      const el = viewport.current
      const z = zoom.current
      nz = clampZoom(nz)
      if (!el || nz === z) return
      cancelAnimationFrame(glide.current)
      // (kept over the graph, as a pan is: the next pan doesn't jump back)
      cam.current = clampCamera(
        zoomAt(cam.current, z, nz, { w: el.clientWidth, h: el.clientHeight }, at),
        nodesRef.current,
        extent.current ?? undefined,
      )
      zoom.current = nz
      // (the level shown once a frame: a pinch's many events don't render the graph each)
      cancelAnimationFrame(zoomFrame.current)
      zoomFrame.current = requestAnimationFrame(showZoom)
      apply()
    },
    [apply],
  )
  // A zoom button: the keys go on reaching the graph after (focus back on it).
  // (a click: focus back on the graph; the keyboard on a button: it stays there)
  const zoomButton = (nz: number, e: { detail: number }) => {
    zoomTo(nz)
    if (e.detail > 0) viewport.current?.focus({ focusVisible: false } as FocusOptions)
  }
  const zoomToRef = useRef(zoomTo)
  zoomToRef.current = zoomTo
  const moveToRef = useRef(moveTo)
  moveToRef.current = moveTo
  const wakeRef = useRef<() => void>(() => {})
  const paintRef = useRef<(now: number) => void>(() => {})

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
      // (the layout grown out, not its first frame at the circle: the camera can reach it all)
      extent.current = bounds(layoutNow(open, repos, Infinity))
      moveTo({ x: FLEET.cx, y: FLEET.cy }, !first && !!open)
    } else {
      extent.current = unionBox(extent.current, bounds(layoutNow(open, repos, Infinity)))
      apply()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `open` only picks the glide
  }, [viewId, nodes, moveTo, apply])

  const toggle = useCallback(
    (key: string) => {
      const closing = openKey === key
      openRoots.current = closing ? [] : (repos.find((r) => r.key === key)?.roots ?? [])
      if (!closing) {
        openedAt.current = reduced.current ? 0 : performance.now()
        grewOut.current = false
      }
      setOpenKey(closing ? null : key)
      setSel(closing ? null : { kind: "repo", key })
      setView((v) => v + 1)
      clearPins() // (pins belong to the view they were made in)
      setPinCount(0)
    },
    [openKey, repos, clearPins, setPinCount, openedAt, reduced, grewOut],
  )
  const closeAll = useCallback(() => {
    openRoots.current = []
    setOpenKey(null)
    setSel(null)
    setView((v) => v + 1)
    clearPins()
    setPinCount(0)
  }, [clearPins, setPinCount])

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
    const { tx, ty, z } = origin(w, h)
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, c.width, c.height)
    ctx.setTransform(dpr * z, 0, 0, dpr * z, tx * dpr, ty * dpr)
    const { red, accent } = ui
    // (on a light background the hairline colour is too pale for an edge: darker there)
    const faint = scheme === "light" ? "rgba(0, 0, 0, 0.3)" : ui.border2
    const ns = nodesRef.current
    const byId = new Map(ns.map((n) => [n.id, n]))
    // The open repo's orbits (PRs, agents, sub-agents): faint dashed rings under everything. They
    // are round in the rings' own space, so the turn never moves them.
    if (open) {
      ctx.save()
      ctx.globalAlpha = 0.55
      ctx.setLineDash([3, 7])
      ctx.lineWidth = 1
      ctx.strokeStyle = faint
      for (const r of [FLEET.r1, FLEET.r2, FLEET.r2 + FLEET.r3]) {
        ctx.beginPath()
        ctx.ellipse(FLEET.cx, FLEET.cy, r * FLEET.ex, r, 0, 0, Math.PI * 2)
        ctx.stroke()
      }
      ctx.restore()
    }
    // Every edge: each card to its parent, and an agent to its other PRs and branches.
    const edges: { n: FleetNode; p: FleetNode; c?: [Camera, Camera] }[] = []
    for (const n of ns)
      for (const to of n.parent ? [n.parent, ...(n.links ?? [])] : []) {
        const p = byId.get(to)
        // (a link curves round the centre: across the graph, a line would cut through the root)
        if (p) edges.push({ n, p, ...(to !== n.parent ? { c: linkCurve(n, p) } : {}) })
      }
    // The selected agent's ways to its repo, drawn green.
    const path = new Set<string>()
    const sel = selectedAgent ? byId.get(nodeId.agent(selectedAgent)) : undefined
    for (const start of sel ? [sel.id, ...(sel.links ?? [])] : [])
      for (let id: string | undefined = start; id; id = byId.get(id)?.parent) path.add(id)
    for (const { n, p, c } of edges) {
      const info = lookup.get(n.id)
      const on = path.has(n.id) && path.has(p.id)
      const blocked = info?.pr?.row && cardLook(info.pr.row).tone === "red"
      ctx.beginPath()
      ctx.moveTo(n.x, n.y)
      if (c) ctx.bezierCurveTo(c[0].x, c[0].y, c[1].x, c[1].y, p.x, p.y)
      else ctx.lineTo(p.x, p.y)
      ctx.setLineDash(n.kind === "sub" || n.kind === "branch" ? [4, 5] : [])
      ctx.lineWidth = on ? 3.5 : 2.25
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
    // The dots running along the lines of working agents and sub-agents.
    if (!reduced.current) {
      const now = performance.now()
      for (const { n, p, c } of edges) {
        const info = lookup.get(n.id)
        const status =
          n.kind === "sub"
            ? info?.sub?.status
            : n.kind === "agent"
              ? info?.agent?.status
              : undefined
        if (status !== "working") continue
        ctx.fillStyle = path.has(n.id)
          ? accent
          : (info?.agent && agentColor(info.agent.kind, scheme)) || accent
        let seed = 0 // (lines out of step with each other: a hash of the ids)
        const key = n.id + p.id
        for (let i = 0; i < key.length; i++) seed = (seed * 31 + key.charCodeAt(i)) % 997
        seed /= 997
        for (const phase of [seed, seed + 0.5]) {
          const d = c
            ? cubicAt(n, c, p, dotAt({ x: 0, y: 0 }, { x: 1, y: 0 }, now, phase).x)
            : dotAt(n, p, now, phase)
          ctx.beginPath()
          ctx.arc(d.x, d.y, 2.5, 0, Math.PI * 2)
          ctx.fill()
        }
      }
    }
  }, [ui, reduced, selectedAgent, lookup, scheme, open])
  drawRef.current = draw
  useEffect(() => apply(), [draw, nodes, apply])

  // The motion loop: one throttled rAF (about 15 frames a second) that runs only while something
  // moves (lib/fleet-motion `moving`): the open repo turning while the mouse is still, its cards
  // growing out, dots on working agents. Each frame lays the open repo out at its angle, writes the
  // cards' places straight to the DOM and redraws the canvas; it never renders React.
  const lastInput = useRef(performance.now())
  const hovered = useRef(false)
  const pointer = useRef<{ x: number; y: number } | null>(null) // (where it was last seen)
  const openRef = useRef(open)
  openRef.current = open
  const reposRef = useRef(repos)
  reposRef.current = repos
  const working = useMemo(
    () =>
      nodes.some((n) => {
        const info = lookup.get(n.id)
        return (
          (n.kind === "agent" && info?.agent?.status === "working") ||
          (n.kind === "sub" && info?.sub?.status === "working")
        )
      }),
    [nodes, lookup],
  )
  const workingRef = useRef(working)
  workingRef.current = working
  const motion = useRef({ on: false, last: 0, raf: 0 })
  const state = useCallback(
    (now: number): MotionState => ({
      open: !!openRef.current,
      shown:
        document.visibilityState !== "hidden" && document.hasFocus() && modeRef.current === "graph",
      reduced: reduced.current,
      hovered: hovered.current,
      sinceInput: now - lastInput.current,
      working: workingRef.current,
      growing: !!openRef.current && now - openedAt.current < GROW_MS,
    }),
    [openedAt, reduced],
  )
  const paint = useCallback(
    (now: number, relayout = true) => {
      if (!relayout) return drawRef.current() // (dots only: the cards haven't moved)
      const ns = layoutNow(openRef.current, reposRef.current, now)
      nodesRef.current = ns
      // (the turn carries cards past where they started: the camera can follow them)
      extent.current = unionBox(extent.current, bounds(ns))
      const els = layer.current?.querySelectorAll<HTMLElement>("[data-node]") ?? []
      const at = new Map(ns.map((n) => [n.id, n]))
      for (const el of els) {
        const n = at.get(el.dataset.node!)
        if (!n || n.kind === "root") continue
        el.style.left = `${n.x - n.w / 2}px`
        el.style.top = `${n.y - n.h / 2}px`
      }
      drawRef.current()
    },
    [layoutNow],
  )
  // A grow-out the loop didn't see through (the window lost focus mid-way, a late frame): its last
  // frame, all placed.
  const finishGrow = useCallback(
    (now: number) => {
      if (grewOut.current || !openRef.current || now - openedAt.current < GROW_MS) return false
      grewOut.current = true
      paint(now)
      return true
    },
    [grewOut, openedAt, paint],
  )
  const wake = useCallback(() => {
    const m = motion.current
    if (!m.on) finishGrow(performance.now())
    if (m.on || !moving(state(performance.now()))) return
    m.on = true
    m.last = performance.now()
    // Two paces: the slow turn relays the cards out about 15 times a second (it moves ~2 px a
    // second); the dots and the brief grow-out run every frame, where 15 would stutter. A frame
    // with only dots redraws just the canvas.
    const tick = (now: number) => {
      const st = state(now)
      if (!moving(st)) {
        m.on = false
        return
      }
      const turns = turning(st)
      if (st.growing) {
        m.last = now
        paint(now, true)
      } else if (finishGrow(now)) m.last = now
      else if (turns && now - m.last >= FRAME_MS) {
        theta.current += Math.min(now - m.last, 250) * TURN_RAD_PER_MS
        m.last = now
        paint(now, true)
      } else if (st.working && !st.reduced) paint(now, false)
      else if (!turns) m.last = now // (a turn starting later counts from now, not from long ago)
      m.raf = requestAnimationFrame(tick)
    }
    m.raf = requestAnimationFrame(tick)
  }, [finishGrow, state, paint, theta])
  // A repo opening grows its cards out of its circle (and starts a turn from where it is).
  useLayoutEffect(() => {
    if (!open) return
    paint(performance.now()) // (the first frame grown from the circle, before anything shows)
    wake()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per open view
  }, [viewId])
  wakeRef.current = wake
  paintRef.current = paint
  // Pins whose card left (its agent ended) go too.
  useEffect(() => {
    let gone = false
    for (const id of pins.current.keys())
      if (!nodes.some((n) => n.id === id)) gone = pins.current.delete(id) || gone
    if (gone) pinsRev.current++
    if (gone) setPinCount(pins.current.size)
  }, [nodes, pins, pinsRev, setPinCount])
  useEffect(() => wake(), [working, nodes, wake])
  useEffect(() => {
    let idle: ReturnType<typeof setTimeout> | undefined
    // Still again: is a card under the pointer now? (the one it was on may have moved away, as a
    // repo circle does when it opens, with no pointer event to say so)
    const settle = () => {
      const p = pointer.current
      if (p) hovered.current = !!document.elementFromPoint?.(p.x, p.y)?.closest?.("[data-node]")
      wake()
    }
    // Any input: the turn stops (where it is); once still again, it starts.
    const input = (e: Event) => {
      if (e instanceof MouseEvent) pointer.current = { x: e.clientX, y: e.clientY }
      lastInput.current = performance.now()
      clearTimeout(idle)
      idle = setTimeout(settle, IDLE_MS + 20)
      wake()
    }
    const events = ["pointermove", "wheel", "keydown", "pointerdown"] as const
    for (const e of events) window.addEventListener(e, input, { passive: true, capture: true })
    window.addEventListener("focus", wake)
    document.addEventListener("visibilitychange", wake)
    idle = setTimeout(settle, IDLE_MS + 20)
    // Reduce Motion switched on (or off) while the tab is open.
    const mq = window.matchMedia?.("(prefers-reduced-motion: reduce)")
    const onReduced = (e: MediaQueryListEvent) => {
      reduced.current = e.matches
      paintRef.current(performance.now())
      wake()
    }
    mq?.addEventListener?.("change", onReduced)
    const m = motion.current
    return () => {
      for (const e of events) window.removeEventListener(e, input, { capture: true })
      window.removeEventListener("focus", wake)
      document.removeEventListener("visibilitychange", wake)
      mq?.removeEventListener?.("change", onReduced)
      clearTimeout(idle)
      cancelAnimationFrame(m.raf)
      m.on = false
    }
  }, [reduced, wake])

  // Panning: the wheel / trackpad, or dragging empty space. A resize needs nothing: the camera is
  // the middle, so the graph stays centred on it.
  useEffect(() => {
    const el = viewport.current
    if (!el) return
    // (screen pixels: a zoomed-in view moves less of the world for the same push)
    const pan = (dx: number, dy: number) => {
      cancelAnimationFrame(glide.current) // the user takes over from an opening's glide
      const z = zoom.current
      cam.current = clampCamera(
        { x: cam.current.x + dx / z, y: cam.current.y + dy / z },
        nodesRef.current,
        extent.current ?? undefined,
      )
      apply()
    }
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      // A pinch (ctrl/cmd with the wheel) zooms about the pointer; else the wheel pans.
      const nz = wheelZoom(e, zoom.current)
      if (nz !== null) {
        const r = el.getBoundingClientRect()
        zoomToRef.current(nz, { x: e.clientX - r.left, y: e.clientY - r.top })
        return
      }
      const d = wheelPan(e, { w: el.clientWidth, h: el.clientHeight })
      if (d) pan(d.dx, d.dy)
    }
    // The keyboard pans too (not from a text field); Home goes back to the view's centre.
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest("input, textarea, select")) return
      const nz = keyZoom(e, zoom.current)
      if (nz !== null) {
        e.preventDefault()
        return zoomToRef.current(nz)
      }
      const d = keyPan(e, el.clientHeight)
      if (!d) return
      e.preventDefault()
      if (d === "home") {
        // (the bounds shrink to the graph once there: a pan mid-glide keeps them as they were)
        moveToRef.current({ x: FLEET.cx, y: FLEET.cy }, true, () => {
          extent.current = bounds(nodesRef.current)
        })
      } else pan(d.dx, d.dy)
    }
    // Hovering a card freezes the turn (it can be clicked); dragging one pins it where it's left.
    const onOver = (e: PointerEvent) => {
      hovered.current = !!(e.target as HTMLElement).closest("[data-node]")
      wakeRef.current()
    }
    let pin: { id: string; x: number; y: number; nx: number; ny: number; moved: boolean } | null =
      null
    const onCardDown = (e: PointerEvent) => {
      const card = (e.target as HTMLElement).closest<HTMLElement>("[data-node]")
      const n = card && nodesRef.current.find((x) => x.id === card.dataset.node)
      if (e.button !== 0 || !n || n.kind === "root") return
      // (no capture yet: a plain click or double-click must reach the card)
      pin = { id: n.id, x: e.clientX, y: e.clientY, nx: n.x, ny: n.y, moved: false }
    }
    const onCardUp = (released: boolean) => {
      if (pin?.moved) {
        if (released) {
          // (the click that ends a drag isn't one; none comes: the guard goes on the next task)
          const eat = (e: MouseEvent) => e.stopPropagation()
          el.addEventListener("click", eat, { capture: true, once: true })
          setTimeout(() => el.removeEventListener("click", eat, { capture: true }), 0)
        }
        setPinCount(pins.current.size)
        setPinVersion((v) => v + 1)
      }
      pin = null
    }
    const onCardMove = (e: PointerEvent) => {
      if (!pin) return
      if ((e.buttons & 1) === 0) return onCardUp(false) // released where we didn't hear it
      const dx = e.clientX - pin.x
      const dy = e.clientY - pin.y
      if (!pin.moved) {
        if (Math.hypot(dx, dy) < 5) return
        pin.moved = true
        el.setPointerCapture?.(e.pointerId) // (a drag now: a release anywhere ends it)
        // (on a keyframe while it drags: one layout a move, not two to blend; under 3px away)
        theta.current = Math.round(theta.current / KEY_RAD) * KEY_RAD
      }
      const z = zoom.current
      pins.current.set(pin.id, { x: pin.nx + dx / z, y: pin.ny + dy / z })
      pinsRev.current++
      // (one layout a frame, however fast the pointer reports)
      dragFrame ||= requestAnimationFrame(() => {
        dragFrame = 0
        paintRef.current(performance.now())
      })
    }
    let dragFrame = 0

    let drag: { x: number; y: number; id: number } | null = null
    const onDown = (e: PointerEvent) => {
      onCardDown(e)
      if (e.button !== 0 || (e.target as HTMLElement).closest("button, .fleet-card")) return
      drag = { x: e.clientX, y: e.clientY, id: e.pointerId }
      el.setPointerCapture?.(e.pointerId)
      el.classList.add("panning")
    }
    const onMove = (e: PointerEvent) => {
      onCardMove(e)
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
      onCardUp(e.type === "pointerup")
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
      // (the dock of other repos covers the view's top while a repo is open)
      const dock = el.parentElement?.querySelector<HTMLElement>(".fleet-dock")
      const top = dock ? dock.getBoundingClientRect().bottom - el.getBoundingClientRect().top : 0
      const z = zoom.current // (the view, and its margin, in world units)
      const view = { w: el.clientWidth / z, h: el.clientHeight / z, top: Math.max(0, top) / z }
      if (!cardInView(n, cam.current, view, 24 / z)) moveToRef.current({ x: n.x, y: n.y }, true)
    }
    const unhover = () => {
      hovered.current = false
      wakeRef.current()
    }
    el.addEventListener("pointerover", onOver)
    el.addEventListener("pointerleave", unhover)
    window.addEventListener("blur", unhover)
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
      el.removeEventListener("pointerover", onOver)
      el.removeEventListener("pointerleave", unhover)
      window.removeEventListener("blur", unhover)
      el.removeEventListener("focusin", onFocus)
      el.removeEventListener("keydown", onKey)
      el.removeEventListener("lostpointercapture", end)
      el.removeEventListener("wheel", onWheel)
      el.removeEventListener("pointerdown", onDown)
      el.removeEventListener("pointermove", onMove)
      el.removeEventListener("pointerup", onUp)
      el.removeEventListener("pointercancel", onUp)
      cancelAnimationFrame(dragFrame)
      ro?.disconnect()
    }
  }, [apply, pins, pinsRev, setPinCount, setPinVersion, theta])

  const docked = open ? repos.filter((r) => r.key !== open.key) : []
  const fleetAgents = useMemo(() => fleetAgentsOf(repos), [repos])
  // Back on the graph: its motion may go on. Leaving it, or a new mark, drops a glide not done.
  const firstMode = useRef(true)
  useEffect(() => {
    if (mode === "graph") {
      wakeRef.current()
      // (back from the inventory: the keys pan the graph again, as when it first showed)
      if (!firstMode.current) viewport.current?.focus({ focusVisible: false } as FocusOptions)
    } else toFind.current = null
    firstMode.current = false
  }, [mode])
  // The first marked session comes into view once its card is placed (its repo may be opening).
  const toFind = useRef<string | null>(null)
  const pickTimer = useRef<number | undefined>(undefined)
  useEffect(() => () => window.clearTimeout(pickTimer.current), [])
  useEffect(() => {
    const id = toFind.current
    if (!id) return
    // (the session ended meanwhile: no glide later, out of nowhere)
    if (!fleetAgents.some((a) => a.id === id)) return void (toFind.current = null)
    const n = nodes.find((x) => x.id === nodeId.agent(id))
    if (!n) return
    toFind.current = null
    // (where it ends up, not the grow-out's first frame)
    const at = layoutNow(open, repos, Infinity).find((x) => x.id === n.id) ?? n
    moveToRef.current({ x: at.x, y: at.y }, true)
  }, [nodes, open, repos, layoutNow, marked, fleetAgents])
  // What's marked now: the picked sessions still open (an ended one leaves the count; none
  // left, no bar).
  const liveMarked = useMemo(() => {
    if (!marked) return null
    const ids = fleetAgents.filter((a) => marked.ids.has(a.id)).map((a) => a.id)
    if (!ids.length) return null
    const repoCount = repos.filter((r) => agentsIn(r).some((a) => ids.includes(a.id))).length
    return { ids, label: marked.label, repos: repoCount }
  }, [marked, fleetAgents, repos])
  /** An inventory row picked: back to the graph, its sessions marked, their repo open. */
  const pick = (ids: string[], label: string) => {
    setMode("graph")
    const repoCount = repos.filter((r) => agentsIn(r).some((a) => ids.includes(a.id))).length
    setMarked({ ids: new Set(ids), label, repos: repoCount })
    // (a glide that can't happen soon, its card not placed, isn't done later out of nowhere;
    // a newer pick's own timer replaces this one)
    window.clearTimeout(pickTimer.current)
    pickTimer.current = window.setTimeout(() => (toFind.current = null), 3000)
    toFind.current = ids[0] ?? null
    // (one in several repos: the open one, if it's there, stays)
    const holds = (r: FleetRepo) => agentsIn(r).some((a) => ids.includes(a.id))
    const repo = open && holds(open) ? open : repos.find(holds)
    if (repo && openKey !== repo.key) toggle(repo.key)
  }

  return (
    <div className="fleet-view">
      <div className="fleet-graph">
        <div className="fleet-modes" role="group" aria-label="Show">
          <button
            className={`fleet-window${mode === "graph" ? " on" : ""}`}
            aria-pressed={mode === "graph"}
            onClick={() => setMode("graph")}
          >
            Graph
          </button>
          <button
            className={`fleet-window${mode === "inventory" ? " on" : ""}`}
            aria-pressed={mode === "inventory"}
            onClick={() => setMode("inventory")}
          >
            Inventory
          </button>
        </div>
        {liveMarked && mode === "graph" && (
          <div className="fleet-marked">
            <span className="one">
              {liveMarked.ids.length} {liveMarked.ids.length === 1 ? "session" : "sessions"} used{" "}
              {liveMarked.label}
              {liveMarked.repos > 1
                ? `, in ${liveMarked.repos} repos (the others in the strip above)`
                : ""}
            </span>
            <button
              className="btn"
              onClick={() => {
                toFind.current = null // (nor glide to it later)
                setMarked(null)
              }}
            >
              Clear
            </button>
          </div>
        )}
        {/* (kept mounted: its window and history stay for the next look) */}
        <div className="fleet-inventory-host" hidden={mode !== "inventory"}>
          <FleetInventory shown={mode === "inventory"} agents={fleetAgents} onPick={pick} />
        </div>
        <canvas className="fleet-edges" ref={canvas} aria-hidden="true" />
        <div
          className="fleet-viewport"
          ref={viewport}
          tabIndex={0}
          // (under the inventory: no focus or keys reach the graph the user can't see)
          inert={mode === "inventory"}
          aria-label="Fleet graph: arrows and Page Up/Down pan it, Home centres it, + and − zoom, 0 back to 100%"
        >
          <div className="fleet-layer" ref={layer}>
            {nodes.map((n) => (
              <FleetCard
                key={n.id}
                node={n}
                info={lookup.get(n.id)}
                open={!!open}
                marked={
                  !!marked &&
                  n.kind === "agent" &&
                  marked.ids.has(lookup.get(n.id)?.agent?.id ?? "")
                }
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
        {mode === "graph" && (
          <div className="fleet-zoom" role="group" aria-label="Zoom" ref={zoomBar}>
            <button
              className="fleet-zoom-btn"
              aria-label="Zoom out"
              title="Zoom out (−)"
              disabled={zoom.current <= ZOOM_MIN}
              onClick={(e) => zoomButton(zoom.current / 1.2, e)}
            >
              <Minus size={13} />
            </button>
            <button
              className="fleet-zoom-btn fleet-zoom-level"
              aria-label="Zoom to 100%"
              title="Back to 100% (0)"
              onClick={(e) => zoomButton(1, e)}
            >
              {Math.round(zoom.current * 100)}%
            </button>
            <button
              className="fleet-zoom-btn"
              aria-label="Zoom in"
              title="Zoom in (+)"
              disabled={zoom.current >= ZOOM_MAX}
              onClick={(e) => zoomButton(zoom.current * 1.2, e)}
            >
              <Plus size={13} />
            </button>
          </div>
        )}
        {pinCount > 0 && mode === "graph" && (
          <button
            className="btn fleet-unpin"
            onClick={() => {
              clearPins()
              setPinCount(0)
            }}
          >
            <PushPinSlash size={13} /> Unpin
          </button>
        )}
        {docked.length > 0 && mode === "graph" && (
          <div className="fleet-dock" aria-label="Other repos">
            {docked.map((r) => (
              <button
                key={r.key}
                className="fleet-dock-repo"
                onClick={() => toggle(r.key)}
                title={`Open ${r.label}`}
              >
                <span className="fleet-dock-dot">
                  {(r.label.split("/").pop() ?? r.label).charAt(0).toUpperCase()}
                </span>
                <span className="fleet-dock-name">{r.label}</span>
                <RepoCounts repo={r} />
              </button>
            ))}
          </div>
        )}
      </div>
      {/* (inert under the inventory: a click there would change the graph out of sight) */}
      <div className="fleet-panel-host" inert={mode === "inventory"}>
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
    </div>
  )
}
