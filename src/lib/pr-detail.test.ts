import { describe, expect, it } from "vitest"
import {
  bodyBlocks,
  bodyRefs,
  hunkTail,
  parsePrDetail,
  threadsByFile,
  when,
  type PrThread,
  whoIs,
} from "./pr-detail"

const answer = (pr: Record<string, unknown>) =>
  JSON.stringify({
    data: {
      repository: {
        pullRequest: {
          url: "https://github.com/o/r/pull/7",
          updatedAt: "2026-10-14T10:00:00Z",
          body: "Body",
          reviews: { totalCount: 0, nodes: [] },
          comments: { totalCount: 0, nodes: [] },
          reviewThreads: { totalCount: 0, nodes: [] },
          ...pr,
        },
      },
    },
  })

describe("parsePrDetail", () => {
  it("the conversation: comments and reviews that say or decide something, oldest first", () => {
    const d = parsePrDetail(
      answer({
        comments: {
          totalCount: 1,
          nodes: [
            { author: { login: "a" }, body: "hi", createdAt: "2026-10-14T09:00:00Z", url: "c1" },
          ],
        },
        reviews: {
          totalCount: 3,
          nodes: [
            {
              author: { login: "b" },
              state: "APPROVED",
              body: "",
              submittedAt: "2026-10-14T08:00:00Z",
              url: "r1",
            },
            {
              author: { login: "c" },
              state: "COMMENTED",
              body: "",
              submittedAt: "2026-10-14T08:30:00Z",
              url: "r2",
            },
            {
              author: null,
              state: "CHANGES_REQUESTED",
              body: "fix",
              submittedAt: "2026-10-14T09:30:00Z",
              url: "r3",
            },
          ],
        },
      }),
    )!
    expect(d.conversation.map((e) => [e.kind, e.author, e.state])).toEqual([
      ["review", "b", "approved"],
      ["comment", "a", undefined],
      ["review", "ghost", "changes"], // a deleted account
    ])
    expect(d.more).toBe(false)
  })

  it("review threads: file, line, resolved / outdated, the first comment's hunk", () => {
    const d = parsePrDetail(
      answer({
        reviewThreads: {
          totalCount: 1,
          nodes: [
            {
              isResolved: false,
              isOutdated: true,
              diffSide: "LEFT",
              path: "src/a.ts",
              line: null,
              comments: {
                totalCount: 2,
                nodes: [
                  {
                    author: { login: "a" },
                    body: "why?",
                    createdAt: "t1",
                    url: "u1",
                    diffHunk: "@@ -1 +1 @@\n-x\n+y",
                  },
                  {
                    author: { login: "me" },
                    body: "because",
                    createdAt: "t2",
                    url: "u2",
                    diffHunk: "",
                  },
                ],
              },
            },
            { path: "" }, // not a thread
          ],
        },
      }),
    )!
    expect(d.threads).toEqual([
      {
        path: "src/a.ts",
        line: null,
        removed: true,
        resolved: false,
        outdated: true,
        hunk: "@@ -1 +1 @@\n-x\n+y",
        comments: [
          { author: "a", body: "why?", at: "t1", url: "u1" },
          { author: "me", body: "because", at: "t2", url: "u2" },
        ],
      },
    ])
  })

  it("a long PR: the conversation keeps the window both lists cover", () => {
    const c = (at: string) => ({ author: { login: "a" }, body: "c", createdAt: at, url: at })
    const d = parsePrDetail(
      answer({
        comments: { totalCount: 250, nodes: [c("2026-10-10"), c("2026-10-12")] }, // the newest
        reviews: {
          totalCount: 2,
          nodes: [
            {
              author: { login: "b" },
              state: "APPROVED",
              body: "",
              submittedAt: "2026-10-01",
              url: "r",
            },
            {
              author: { login: "b" },
              state: "APPROVED",
              body: "",
              submittedAt: "2026-10-11",
              url: "r2",
            },
          ],
        },
      }),
    )!
    expect(d.conversation.map((e) => e.at)).toEqual(["2026-10-10", "2026-10-11", "2026-10-12"])
    expect(d.more).toBe(true)
  })

  it("more than the query asks for: says so", () => {
    expect(parsePrDetail(answer({ comments: { totalCount: 101, nodes: [] } }))!.more).toBe(true)
  })

  it("not an answer (no such PR, garbage): null", () => {
    expect(parsePrDetail("x")).toBeNull()
    expect(
      parsePrDetail(JSON.stringify({ data: { repository: { pullRequest: null } } })),
    ).toBeNull()
  })
})

describe("threadsByFile", () => {
  const t = (path: string, line: number | null, over: Partial<PrThread> = {}): PrThread => ({
    path,
    line,
    resolved: false,
    outdated: false,
    removed: false,
    hunk: "",
    comments: [],
    ...over,
  })
  it("files in path order; open threads first, then by line", () => {
    const out = threadsByFile([
      t("b.ts", 1),
      t("a.ts", 9),
      t("a.ts", 3, { resolved: true }),
      t("a.ts", 5),
    ])
    expect(out.map((f) => [f.path, f.threads.map((x) => x.line), f.open])).toEqual([
      ["a.ts", [5, 9, 3], 2],
      ["b.ts", [1], 1],
    ])
  })
})

describe("hunkTail", () => {
  it("the last lines, without the @@ header", () => {
    expect(hunkTail("@@ -1,3 +1,3 @@\n a\n-b\n+c", 2)).toEqual(["-b", "+c"])
  })
})

describe("bodyBlocks", () => {
  it("text and fenced code, in order", () => {
    expect(bodyBlocks("Intro\n\n```ts\nconst x = 1\n```\nAfter")).toEqual([
      { code: false, text: "Intro" },
      { code: true, text: "const x = 1" },
      { code: false, text: "After" },
    ])
    expect(bodyBlocks("a\r\n```\r\nx\r\n```\r\nb")).toEqual([
      { code: false, text: "a" },
      { code: true, text: "x" },
      { code: false, text: "b" },
    ]) // GitHub's web editor writes \r\n
    expect(bodyBlocks("  ")).toEqual([])
    expect(bodyBlocks("<img src=x onerror=alert(1)>")).toEqual([
      { code: false, text: "<img src=x onerror=alert(1)>" }, // text, never HTML
    ])
  })
})

describe("when", () => {
  const now = Date.parse("2026-10-14T12:00:00Z")
  it("short and relative, then a date", () => {
    expect(when("2026-10-14T11:59:50Z", now)).toBe("just now")
    expect(when("2026-10-14T11:30:00Z", now)).toBe("30 min ago")
    expect(when("2026-10-13T12:00:00Z", now)).toBe("24 h ago")
    expect(when("2026-10-01T00:00:00Z", now)).toBe("2026-10-01")
    expect(when("", now)).toBe("")
  })
})

describe("links", () => {
  const ref = (typename: string, n: number, over: Record<string, unknown> = {}) => ({
    __typename: typename,
    number: n,
    title: `T${n}`,
    url: `https://github.com/o/r/${typename === "Issue" ? "issues" : "pull"}/${n}`,
    state: "OPEN",
    repository: { nameWithOwner: "o/r" },
    ...over,
  })

  it("closes, and mentioned by (newest first, once each, never itself)", () => {
    const d = parsePrDetail(
      answer({
        closingIssuesReferences: { nodes: [ref("Issue", 3)] },
        timelineItems: {
          nodes: [
            { source: ref("PullRequest", 8, { state: "MERGED" }) },
            { source: ref("PullRequest", 9, { isDraft: true }) },
            { source: ref("PullRequest", 8, { state: "MERGED" }) },
            { source: ref("PullRequest", 7) }, // itself
            { source: { __typename: "Discussion" } },
            {},
          ],
        },
      }),
    )!
    expect(d.links.closes).toEqual([
      {
        url: "https://github.com/o/r/issues/3",
        number: 3,
        repo: "o/r",
        title: "T3",
        kind: "issue",
        state: "open",
      },
    ])
    expect(d.links.mentionedBy.map((l) => [l.number, l.state])).toEqual([
      [8, "merged"], // its newest mention is the last
      [9, "draft"],
    ])
  })

  it("an issue it closes isn't also listed as mentioned", () => {
    const d = parsePrDetail(
      answer({ body: "Fixes #3, after #4", closingIssuesReferences: { nodes: [ref("Issue", 3)] } }),
    )!
    expect(d.links.mentions.map((l) => l.number)).toEqual([4])
  })

  it("an issue it closes that mentions it back is listed once", () => {
    const d = parsePrDetail(
      answer({
        closingIssuesReferences: { nodes: [ref("Issue", 3)] },
        timelineItems: { nodes: [{ source: ref("Issue", 3) }] },
      }),
    )!
    expect(d.links.mentionedBy).toEqual([])
  })

  it("an answer without links: none", () => {
    expect(parsePrDetail(answer({}))!.links).toEqual({ closes: [], mentions: [], mentionedBy: [] })
  })
})

describe("bodyRefs", () => {
  const self = "https://github.com/o/r/pull/7"
  const nums = (body: string) => bodyRefs(body, self).map((l) => `${l.repo}#${l.number}`)

  it("#N, owner/name#N and GitHub links, in order, once each, never itself", () => {
    expect(
      nums(
        "Stacked on #5, see x/y#2 and https://github.com/a/b/pull/4 or https://github.com/o/r/issues/5. Not #7.",
      ),
    ).toEqual(["o/r#5", "x/y#2", "a/b#4"])
  })

  it("not in HTML comments (PR templates)", () => {
    expect(nums("<!-- e.g. Closes #123 -->\nafter #4")).toEqual(["o/r#4"])
  })

  it("not in code, nor URL fragments or HTML entities", () => {
    expect(nums("```\nfix #1\n```\n`#2` https://x.io/page#3 &#4; a#5 #6")).toEqual(["o/r#6"])
  })

  it("a GitHub link knows its kind; a bare #N doesn't", () => {
    const [a, b] = bodyRefs("https://github.com/o/r/issues/3 #4", self)
    expect([a!.kind, b!.kind]).toEqual(["issue", null])
  })
})

describe("whoIs", () => {
  const ctx = { mine: ["winlp4ever", "quanghexa94"], acting: "winlp4ever", author: "Bob" }
  it("any of your accounts is you; another than the acting one is marked so", () => {
    expect(whoIs("WinLP4ever", ctx)).toEqual({ you: true, other: false, author: false })
    expect(whoIs("quanghexa94", ctx)).toEqual({ you: true, other: true, author: false })
    expect(whoIs("bob", ctx)).toEqual({ you: false, other: false, author: true })
    expect(whoIs("alice", { mine: [] })).toEqual({ you: false, other: false, author: false })
  })
})
