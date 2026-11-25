// Where the Fleet view's cards are (docs/design/FLEET_GRAPH.md, "Motion", "Performance budget"):
// the open repo's angle, its grow-out, the cards pinned by a drag, and the one function that lays
// it all out for React and the motion loop alike. Refs, so the loop moves cards without a render.
import { useCallback, useRef, useState } from "react"
import { openLayout, overviewLayout, relax, type FleetNode } from "../lib/fleet-layout"
import type { FleetRepo } from "../lib/fleet-model"
import { GROW_MS, KEY_RAD, between, grown, withPins } from "../lib/fleet-motion"

export function useFleetLayout() {
  // The cards pinned by a drag, where they were left.
  const pins = useRef(new Map<string, { x: number; y: number }>())
  const pinsRev = useRef(0) // (any pin change: the cached keyframes go)
  const clearPins = useCallback(() => {
    if (pins.current.size) pinsRev.current++
    pins.current.clear()
  }, [])
  // Motion (lib/fleet-motion): the open repo's angle, the nodes pinned by a drag, when it opened
  // (its cards grow out). React lays the graph out at the current angle with the pins on, so a
  // model update mid-turn never makes a card jump; the motion loop below moves them in between.
  const theta = useRef(0)
  const [pinCount, setPinCount] = useState(0)
  const openedAt = useRef(0)
  const grewOut = useRef(true) // (the grow-out's last frame painted: a cut-short one is finished)
  const [, setPinVersion] = useState(0) // a pin moved: render with it
  const reduced = useRef(
    typeof window !== "undefined" &&
      !!window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches,
  )
  // The one place positions come from, for React and the motion loop alike. The open repo turns
  // through keyframes, one a second (lib/fleet-motion KEY_MS), each laid out at its angle with the
  // pinned cards where they were left (fixed in the overlap pass, what hangs off them moved
  // along); a frame blends the two around it and scales them while they grow out. So the overlap
  // pass (O(n²)) runs about once a second while turning and never per frame, and a render that
  // changes nothing gets the same array back (the effects keyed on it stay quiet).
  const cache = useRef<{
    repo: FleetRepo | null
    all: FleetRepo[] | null
    rev: number
    keys: Map<number, FleetNode[]>
    over: { all: FleetRepo[]; ns: FleetNode[] } | null
    mix: { a: FleetNode[]; b: FleetNode[]; k: number; ns: FleetNode[] } | null
  }>({ repo: null, all: null, rev: 0, keys: new Map(), over: null, mix: null })
  const layoutNow = useCallback((repo: FleetRepo | null, all: FleetRepo[], now: number) => {
    const c = cache.current
    if (!repo) {
      if (c.over?.all !== all) c.over = { all, ns: overviewLayout(all) }
      return c.over.ns
    }
    if (c.repo !== repo || c.all !== all || c.rev !== pinsRev.current) {
      Object.assign(c, { repo, all, rev: pinsRev.current, keys: new Map(), mix: null })
    }
    const pinned = pins.current
    const fixed = pinned.size ? new Set(pinned.keys()) : undefined
    const key = (i: number) => {
      let ns = c.keys.get(i)
      if (!ns) {
        // (pins are where a card was left in the settled layout: what hangs off a pinned card
        // moves by its offset from there, then the pass runs again around the pins)
        ns = relax(openLayout(repo, i * KEY_RAD))
        if (fixed) ns = relax(withPins(ns, pinned), 40, fixed)
        if (c.keys.size >= 4) c.keys.delete(c.keys.keys().next().value!)
        c.keys.set(i, ns)
      }
      return ns
    }
    const step = theta.current / KEY_RAD
    const i = Math.floor(step)
    const k = step - i
    const a = key(i)
    let ns = a
    if (k > 1e-9) {
      const b = key(i + 1)
      if (c.mix?.a !== a || c.mix.b !== b || c.mix.k !== k)
        c.mix = { a, b, k, ns: between(a, b, k) }
      ns = c.mix.ns
    }
    return reduced.current ? ns : grown(ns, (now - openedAt.current) / GROW_MS, fixed)
  }, [])
  return {
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
  }
}
