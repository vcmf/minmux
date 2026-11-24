import { describe, it, expect } from "vitest"
import { cardLook, edgePath, graphLayout, graphMove, GRAPH } from "./pr-graph"
import { stackRows } from "./pr-stacks"
import type { PrRow } from "./pr-dashboard"

const row = (n: number, over: Partial<PrRow> = {}): PrRow => ({
  number: n,
  title: `PR ${n}`,
  url: `https://github.com/${over.repo ?? "o/r"}/pull/${n}`,
  repo: "o/r",
  defaultBranch: "main",
  author: "me",
  state: "open",
  head: `b${n}`,
  fork: false,
  base: "main",
  review: null,
  reviewers: [],
  requested: [],
  merge: "clean",
  ci: null,
  comments: 0,
  additions: 1,
  deletions: 0,
  updatedAt: "",
  ...over,
})

const layout = (rows: PrRow[], all = rows, here?: string) => graphLayout(stackRows(rows, all), here)
const node = (g: ReturnType<typeof layout>, n: number) => g.nodes.find((x) => x.row.number === n)!

describe("cardLook", () => {
  it("red for conflicts, failing CI or changes requested; amber while CI runs", () => {
    expect(cardLook(row(1, { merge: "conflicts" })).tone).toBe("red")
    expect(cardLook(row(1, { ci: "failure" })).tone).toBe("red")
    expect(cardLook(row(1, { review: "changes" })).tone).toBe("red")
    expect(cardLook(row(1, { ci: "pending" })).tone).toBe("amber")
    expect(cardLook(row(1, { ci: "pending", merge: "conflicts" })).tone).toBe("red") // worst wins
    expect(cardLook(row(1, { ci: "success", merge: "unknown" })).tone).toBeNull()
  })

  it("a draft keeps its colour; merged / closed are never coloured; approved apart", () => {
    expect(cardLook(row(1, { state: "draft", ci: "pending" }))).toMatchObject({
      tone: "amber",
      draft: true,
    })
    expect(cardLook(row(1, { state: "merged", ci: "failure" }))).toMatchObject({
      tone: null,
      done: "merged",
    })
    expect(cardLook(row(1, { review: "approved", ci: "failure" }))).toMatchObject({
      tone: "red",
      approved: true,
    })
  })
})

describe("graphLayout", () => {
  it("a stack: columns by depth, a PR on its first child's line, a sibling below", () => {
    // 1 ← 2 ← 3, and 4 on 1 too
    const g = layout([
      row(1),
      row(2, { base: "b1" }),
      row(3, { base: "b2" }),
      row(4, { base: "b1" }),
    ])
    expect([1, 2, 3, 4].map((n) => [node(g, n).col, node(g, n).line])).toEqual([
      [0, 0],
      [1, 0],
      [2, 0],
      [1, 1],
    ])
    expect(node(g, 2).parent).toBe(row(1).url)
    expect(node(g, 1).kids).toEqual([row(2).url, row(4).url])
    expect(g.roots).toHaveLength(1)
    expect(g.roots[0]).toMatchObject({ repo: "o/r", branch: "main" })
    // root → 1, 1 → 2, 2 → 3, 1 → 4
    expect(g.edges).toHaveLength(4)
  })

  it("one root per repo, in the order their first PR is listed, a line between them", () => {
    const g = layout([
      row(1, { repo: "a/x", defaultBranch: "develop" }),
      row(2, { repo: "b/y" }),
      row(3, { repo: "a/x", defaultBranch: "develop" }),
    ])
    expect(g.roots.map((r) => [r.repo, r.branch])).toEqual([
      ["a/x", "develop"],
      ["b/y", "main"],
    ])
    expect(node(g, 3).line).toBe(1) // a/x's second PR, before b/y's
    expect(node(g, 2).line).toBe(2)
    expect(g.seps).toHaveLength(1)
    expect(node(g, 2).y).toBeGreaterThan(g.seps[0]!)
    expect(g.seps[0]!).toBeGreaterThan(node(g, 3).y + GRAPH.cardH)
  })

  it("no default branch known (an older answer): the root shows the repo alone, no labels", () => {
    const g = layout([row(1, { defaultBranch: undefined, base: "release/1" })])
    expect(g.roots[0]!.branch).toBeUndefined()
    expect(g.labels).toEqual([])
  })

  it("a base that's neither the default branch nor a listed PR: the edge says which", () => {
    const g = layout([row(1, { base: "release/1.2" }), row(2)])
    expect(g.labels.map((l) => l.text)).toEqual(["release/1.2"])
  })

  it("a base PR in another tab: a stub between the root and the PR, one column right", () => {
    const base = row(9)
    const g = layout([row(2, { base: "b9" })], [base, row(2, { base: "b9" })])
    expect(g.stubs.map((s) => s.on.number)).toEqual([9])
    expect(node(g, 2).col).toBe(1)
    expect(g.edges).toHaveLength(2) // root → stub → PR
    expect(g.labels).toEqual([]) // (the stub says it)
  })

  it("a fork PR stacks under the PR whose head is its base, as the list does", () => {
    const g = layout([row(1), row(2, { fork: true, base: "b1" })])
    expect(node(g, 2).parent).toBe(row(1).url)
  })

  it("a cycle is broken once, as the list breaks it (no endless walk)", () => {
    const g = layout([row(1, { base: "b2" }), row(2, { base: "b1" })])
    expect(g.nodes.map((n) => [n.col, n.parent])).toEqual([
      [0, null],
      [1, row(1).url],
    ])
  })

  it("the way from the root to the focused pane's PR is hot, nothing else", () => {
    const rows = [row(1), row(2, { base: "b1" }), row(3, { base: "b1" })]
    const g = layout(rows, rows, row(2).url)
    expect(g.edges.filter((e) => e.hot).map((e) => e.key)).toEqual([
      `root ${row(1).url}`,
      `${row(1).url} ${row(2).url}`,
    ])
  })

  it("size: every card fits; nothing listed, nothing laid out", () => {
    const g = layout([row(1), row(2, { base: "b1" })])
    expect(g.width).toBe(node(g, 2).x + GRAPH.cardW + GRAPH.pad)
    expect(g.height).toBe(node(g, 1).y + GRAPH.cardH + GRAPH.pad)
    expect(layout([])).toMatchObject({ nodes: [], roots: [], width: GRAPH.pad * 2 + GRAPH.rootW })
  })
})

describe("edgePath", () => {
  it("level: a straight line; else a curve leaving and arriving level", () => {
    expect(edgePath(0, 10, 50, 10)).toBe("M0 10 H50")
    expect(edgePath(0, 10, 50, 90)).toBe("M0 10 C25 10 25 90 50 90")
  })
})

describe("graphMove", () => {
  // 1 ← 2 ← 3 on line 0, 4 on 1 (line 1), 5 alone (line 2)
  const g = layout([
    row(1),
    row(2, { base: "b1" }),
    row(3, { base: "b2" }),
    row(4, { base: "b1" }),
    row(5),
  ])
  const u = (n: number) => row(n).url

  it("left: the base PR; right: its first stacked PR", () => {
    expect(graphMove(g, u(3), "left")).toBe(u(2))
    expect(graphMove(g, u(1), "left")).toBeNull()
    expect(graphMove(g, u(1), "right")).toBe(u(2))
    expect(graphMove(g, u(3), "right")).toBeNull()
  })

  it("up / down: the next line, the closest column on it", () => {
    expect(graphMove(g, u(3), "down")).toBe(u(4)) // line 1 has only 4
    expect(graphMove(g, u(4), "down")).toBe(u(5))
    expect(graphMove(g, u(4), "up")).toBe(u(2)) // line 0, column 1
    expect(graphMove(g, u(1), "up")).toBeNull()
  })

  it("nothing selected: the first PR", () => {
    expect(graphMove(g, null, "down")).toBe(u(1))
  })
})
