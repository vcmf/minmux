// The pull requests dialog's graph view (docs/design/PR_GRAPH.md): the tab's stack rows laid out
// as a tree per repo (a root named after the repo and its default branch, each PR right of the
// PR it's based on), the edges as SVG paths, a card's look from its PR's state, and the arrow
// keys' moves. Pure; the rows are the list's own (`stackRows`), so both views agree.
import type { PrRow } from "./pr-dashboard"
import type { StackRow } from "./pr-stacks"

/** Sizes in px: cards, roots, the gaps between columns / rows / repos. */
export const GRAPH = {
  pad: 20,
  rootW: 196,
  rootH: 60,
  cardW: 272,
  cardH: 78,
  stubW: 112,
  stubH: 26,
  colGap: 56,
  rowGap: 16,
  repoGap: 32,
}

export type CardTone = "red" | "amber" | null

/** What a card's look says: its worst problem, a draft, merged / closed, approved. */
export interface CardLook {
  tone: CardTone // red: conflicts, CI failing, changes requested; amber: CI running
  draft: boolean
  done: "merged" | "closed" | null // muted, never coloured
  approved: boolean
}

export function cardLook(r: PrRow): CardLook {
  const done = r.state === "merged" || r.state === "closed" ? r.state : null
  const red = r.merge === "conflicts" || r.ci === "failure" || r.review === "changes"
  return {
    tone: done ? null : red ? "red" : r.ci === "pending" ? "amber" : null,
    draft: r.state === "draft",
    done,
    approved: r.review === "approved",
  }
}

/** A repo's root: the repo and its default branch (unknown in an answer from an older build). */
export interface GraphRoot {
  repo: string
  branch?: string
  url: string // a PR of it (a root is opened by its repo)
  x: number
  y: number
}

/** A PR's card. `line`: its row in the graph; `col`: its depth (a stub adds one). */
export interface GraphNode {
  row: PrRow
  x: number
  y: number
  line: number
  col: number
  parent: string | null // the url of the PR it's based on (null: its repo's root)
  kids: string[]
}

/** The base PR of a stack's bottom, listed in another tab: a small node opening it. */
export interface GraphStub {
  on: PrRow
  for: string // the url of the PR it leads to (two stacks can share a base)
  x: number
  y: number
}

/** An edge as an SVG path; `hot` on the way from a root to the focused pane's PR. */
export interface GraphEdge {
  key: string
  d: string
  hot: boolean
}

/** A bottom PR's base branch that's neither the default branch nor a known PR's. */
export interface GraphLabel {
  text: string
  x: number // its left end: over the card's top edge, in the gap above it
  y: number
}

export interface GraphLayout {
  roots: GraphRoot[]
  nodes: GraphNode[] // grouped by repo, in the list's order within each
  stubs: GraphStub[]
  edges: GraphEdge[]
  labels: GraphLabel[]
  seps: number[] // a line between two repos, at this y
  width: number
  height: number
}

type Tree = { s: StackRow; kids: Tree[]; line: number }

const repoKey = (r: PrRow) => r.repo.toLowerCase()

/** A curve from (x1, y1) to (x2, y2), leaving and arriving level. */
export function edgePath(x1: number, y1: number, x2: number, y2: number): string {
  if (y1 === y2) return `M${x1} ${y1} H${x2}`
  const dx = (x2 - x1) / 2
  return `M${x1} ${y1} C${x1 + dx} ${y1} ${x2 - dx} ${y2} ${x2} ${y2}`
}

/** The tab's stack rows → the graph: repos in the order their first PR is listed. */
export function graphLayout(stack: StackRow[], here?: string): GraphLayout {
  const G = GRAPH
  // the forest back from the rows' depths (each row right under its parent's subtree)
  const repos = new Map<string, Tree[]>()
  const path: Tree[] = []
  for (const s of stack) {
    const t: Tree = { s, kids: [], line: 0 }
    const parent = s.depth > 0 ? path[s.depth - 1] : undefined
    if (parent) parent.kids.push(t)
    else {
      const k = repoKey(s.row)
      repos.set(k, [...(repos.get(k) ?? []), t])
    }
    path[s.depth] = t
    path.length = s.depth + 1
  }

  // the urls from a root down to the focused pane's PR
  const hot = new Set<string>()
  const parentOf = new Map<string, string>()
  const index = (t: Tree) => {
    for (const k of t.kids) {
      parentOf.set(k.s.row.url, t.s.row.url)
      index(k)
    }
  }
  for (const ts of repos.values()) ts.forEach(index)
  for (let u = here; u; u = parentOf.get(u)) hot.add(u)

  const out: GraphLayout = {
    roots: [],
    nodes: [],
    stubs: [],
    edges: [],
    labels: [],
    seps: [],
    width: 0,
    height: 0,
  }
  const x0 = G.pad + G.rootW + G.colGap
  const colX = (c: number) => x0 + c * (G.cardW + G.colGap)
  let line = 0
  let gaps = 0
  const lineY = (l: number) => G.pad + l * (G.cardH + G.rowGap) + gaps * G.repoGap
  // A node shares its first child's line; each further child (and a leaf) takes a new one.
  const place = (t: Tree): number => {
    if (!t.kids.length) return (t.line = line++)
    t.kids.forEach(place)
    return (t.line = t.kids[0]!.line)
  }
  let maxRight = G.pad + G.rootW
  let r = 0
  for (const ts of repos.values()) {
    if (r > 0) {
      const y = lineY(line) - G.rowGap / 2
      gaps++
      out.seps.push(y + G.repoGap / 2)
    }
    r++
    ts.forEach(place)
    const first = ts[0]!.s.row
    const def = ts.map((t) => t.s.row.defaultBranch).find(Boolean)
    const rootY = lineY(ts[0]!.line) + (G.cardH - G.rootH) / 2
    out.roots.push({
      repo: first.repo,
      ...(def ? { branch: def } : {}),
      url: first.url,
      x: G.pad,
      y: rootY,
    })
    const rootOut = { x: G.pad + G.rootW, y: rootY + G.rootH / 2 }
    const walk = (t: Tree, col: number, parent: string | null) => {
      const y = lineY(t.line)
      const x = colX(col)
      const mid = y + G.cardH / 2
      out.nodes.push({
        row: t.s.row,
        x,
        y,
        line: t.line,
        col,
        parent,
        kids: t.kids.map((k) => k.s.row.url),
      })
      maxRight = Math.max(maxRight, x + G.cardW)
      for (const k of t.kids) {
        const ky = lineY(k.line) + G.cardH / 2
        out.edges.push({
          key: `${t.s.row.url} ${k.s.row.url}`,
          d: edgePath(x + G.cardW, mid, colX(col + 1), ky),
          hot: hot.has(k.s.row.url),
        })
        walk(k, col + 1, t.s.row.url)
      }
    }
    for (const t of ts) {
      const row = t.s.row
      const mid = lineY(t.line) + G.cardH / 2
      const on = t.s.on
      if (on) {
        // root → stub → the PR, one column right
        const sx = colX(0)
        const sy = mid - G.stubH / 2
        out.stubs.push({ on, for: row.url, x: sx, y: sy })
        out.edges.push({
          key: `root ${row.url} stub`,
          d: edgePath(rootOut.x, rootOut.y, sx, mid),
          hot: hot.has(row.url),
        })
        out.edges.push({
          key: `stub ${row.url}`,
          d: edgePath(sx + G.stubW, mid, colX(1), mid),
          hot: hot.has(row.url),
        })
        walk(t, 1, null)
        continue
      }
      out.edges.push({
        key: `root ${row.url}`,
        d: edgePath(rootOut.x, rootOut.y, colX(0), mid),
        hot: hot.has(row.url),
      })
      if (def && row.base && row.base !== def)
        out.labels.push({ text: `on ${row.base}`, x: colX(0) + 4, y: lineY(t.line) - 13 })
      walk(t, 0, null)
    }
  }
  out.width = maxRight + G.pad
  out.height = line ? lineY(line) - G.rowGap + G.pad : 0
  return out
}

export type GraphKey = "left" | "right" | "up" | "down"

/** The PR an arrow key moves to from `url` (null: none there; no `url`: the first). */
export function graphMove(g: GraphLayout, url: string | null, key: GraphKey): string | null {
  const at = g.nodes.find((n) => n.row.url === url)
  if (!at) return g.nodes[0]?.row.url ?? null
  if (key === "left") return at.parent
  if (key === "right") return at.kids[0] ?? null
  // up / down: the nearest line that way, then the closest column on it
  const down = key === "down"
  let best: GraphNode | null = null
  for (const n of g.nodes) {
    if (down ? n.line <= at.line : n.line >= at.line) continue
    if (
      !best ||
      (down ? n.line < best.line : n.line > best.line) ||
      (n.line === best.line && Math.abs(n.col - at.col) < Math.abs(best.col - at.col))
    )
      best = n
  }
  return best?.row.url ?? null
}
