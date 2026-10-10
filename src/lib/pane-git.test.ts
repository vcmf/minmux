import { describe, it, expect } from "vitest"
import { mergePaneGit, messageSnippet, prStateUi } from "./pane-git"

describe("prStateUi", () => {
  it("labels + theme colours per state", () => {
    expect(prStateUi("open")).toEqual({ word: "open", color: "accent" })
    expect(prStateUi("merged").word).toBe("merged")
    expect(prStateUi("closed").color).toBe("red")
    expect(prStateUi("draft").word).toBe("draft")
  })
})

describe("messageSnippet", () => {
  it("strips markdown + collapses whitespace", () => {
    expect(messageSnippet("**Done.** See [#51](https://x/51)\n\n```ts\ncode\n```\n- `a` b")).toBe(
      "Done. See #51 - a b",
    )
    expect(messageSnippet(undefined)).toBe("")
  })

  it("keeps underscores / asterisks inside identifiers and paths", () => {
    expect(messageSnippet("Updated `pane_git.ts` and SIDEBAR_WIDTH; a*b stays, *em* goes")).toBe(
      "Updated pane_git.ts and SIDEBAR_WIDTH; a*b stays, em goes",
    )
  })
})

describe("mergePaneGit", () => {
  const pr = { number: 1, state: "open" as const, url: "u" }
  it("same map when nothing changed; new map when something did", () => {
    const cur = { a: { branch: "x", pr } }
    expect(mergePaneGit(cur, { a: { branch: "x", pr: { ...pr } } })).toBe(cur)
    const next = mergePaneGit(cur, { a: { branch: "x", pr: { ...pr, state: "merged" } } })
    expect(next).not.toBe(cur)
    expect(next.a?.pr?.state).toBe("merged")
  })
})

describe("mergePaneGit — prefix", () => {
  it("an answer that differs only in its place in the repo is news (a `cd` within it)", () => {
    const cur = { a: { root: "/r", prefix: "" } }
    const next = mergePaneGit(cur, { a: { root: "/r", prefix: "sub" } })
    expect(next).not.toBe(cur)
    expect(next.a?.prefix).toBe("sub")
  })
})
