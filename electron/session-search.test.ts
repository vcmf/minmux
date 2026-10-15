import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { execFileSync } from "node:child_process"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { AgentKind } from "../src/lib/agent-graph"
import type { SessionHit } from "../src/lib/past-sessions"
import { claudeTexts } from "./agents/claude-history"
import { codexTexts } from "./agents/codex-history"
import {
  bytePattern,
  onDisk,
  searchFiles,
  snippetOf,
  verify,
  type SearchFile,
} from "./session-search"

const j = (o: unknown) => JSON.stringify(o)
const texts = (agent: AgentKind, o: Record<string, unknown>) =>
  agent === "codex" ? codexTexts(o) : claudeTexts(o)
const claudeUser = (content: string) => j({ type: "user", message: { role: "user", content } })
const claudeReply = (text: string) =>
  j({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } })
const claudeTool = (out: string) =>
  j({ type: "user", message: { role: "user", content: [{ type: "tool_result", content: out }] } })
const codexReply = (text: string) =>
  j({
    type: "response_item",
    payload: { type: "message", role: "assistant", content: [{ type: "output_text", text }] },
  })

let rg: string | null = null
try {
  rg = execFileSync("sh", ["-c", "command -v rg"], { encoding: "utf8" }).trim() || null
} catch {
  rg = null
}

describe("snippetOf", () => {
  it("finds the words ignoring case, with some context, on one line", () => {
    const s = snippetOf("We fixed the\nQuit Drain today", "quit drain")!
    expect(s.snippet).toBe("We fixed the Quit Drain today")
    expect(s.snippet.slice(s.match, s.match + s.length)).toBe("Quit Drain")
  })

  it("cuts a long text around the match", () => {
    const s = snippetOf(`${"a".repeat(200)} needle ${"b".repeat(200)}`, "NEEDLE")!
    expect(s.snippet.startsWith("…")).toBe(true)
    expect(s.snippet.endsWith("…")).toBe(true)
    expect(s.snippet.slice(s.match, s.match + s.length)).toBe("needle")
  })

  it("any whitespace between the words, punctuation taken as is, the match exactly marked", () => {
    const s = snippetOf(
      "we fixed the\nquit-drain  (for real) on İstanbul deploy",
      "QUIT-DRAIN (for real)",
    )!
    expect(s.snippet.slice(s.match, s.match + s.length)).toBe("quit-drain (for real)")
    const t = snippetOf("İİİ deploy failed", "deploy")!
    expect(t.snippet.slice(t.match, t.match + t.length)).toBe("deploy")
  })

  it("never cuts an emoji in half at the snippet's ends", () => {
    const text = "😀".repeat(40) + " needle " + "😀".repeat(40)
    const s = snippetOf(text, "needle")!
    expect(s.snippet).not.toMatch(
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/,
    )
    expect(s.snippet.slice(s.match, s.match + s.length)).toBe("needle")
  })

  it("nothing when the words aren't there", () => {
    expect(snippetOf("hello", "bye")).toBeUndefined()
  })
})

describe("verify", () => {
  const f: SearchFile = { agent: "claude", sessionId: "s", file: "/x" }

  it("counts what the user typed and what the agent replied", () => {
    expect(verify(f, claudeUser("fix the Quit drain"), "quit DRAIN", texts)).toMatchObject({
      agent: "claude",
      sessionId: "s",
    })
    expect(verify(f, claudeReply("the quit drain is fixed"), "quit drain", texts)).toBeDefined()
  })

  it("never tool output, a slash command's record, JSON keys or a line that isn't JSON", () => {
    expect(verify(f, claudeTool("quit drain in a file"), "quit drain", texts)).toBeUndefined()
    expect(
      verify(f, claudeUser("<command-name>/quit drain</command-name>"), "quit drain", texts),
    ).toBeUndefined()
    expect(verify(f, claudeUser("hello"), "message", texts)).toBeUndefined() // a key, not text
    expect(verify(f, "quit drain", "quit drain", texts)).toBeUndefined()
  })

  it("Codex's replies count too", () => {
    const cf = { ...f, agent: "codex" as const }
    expect(verify(cf, codexReply("Done: the quit drain"), "quit drain", texts)).toBeDefined()
  })
})

describe("searchFiles", () => {
  let dir: string
  const file = (name: string, lines: string[]) => {
    const p = path.join(dir, name)
    fs.writeFileSync(p, lines.join("\n") + "\n")
    return p
  }
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "search-"))
  })
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

  const fixtures = (): SearchFile[] => [
    {
      agent: "claude",
      sessionId: "a",
      file: file("a.jsonl", [claudeTool('a quote: "x"'), claudeUser('say "x" please')]),
    },
    { agent: "claude", sessionId: "b", file: file("b.jsonl", [claudeTool('only "x" in a tool')]) },
    { agent: "codex", sessionId: "c", file: file("c.jsonl", [codexReply('Said "X".')]) },
  ]

  for (const mode of ["streamed", "rg"] as const) {
    it.skipIf(mode === "rg" && !rg)(
      `${mode}: one hit per session whose conversation has the words`,
      async () => {
        const hits: SessionHit[] = []
        const r = await searchFiles(fixtures(), '"x"', {
          rg: mode === "rg" ? rg : null,
          texts,
          signal: new AbortController().signal,
          onHit: (h) => hits.push(h),
        })
        expect(hits.map((h) => h.sessionId).sort()).toEqual(["a", "c"])
        expect(r.capped).toBe(false)
      },
    )

    it.skipIf(mode === "rg" && !rg)(`${mode}: stops at the most sessions it shows`, async () => {
      const files = Array.from({ length: 5 }, (_, i) => ({
        agent: "claude" as const,
        sessionId: `s${i}`,
        file: file(`s${i}.jsonl`, [claudeUser("needle")]),
      }))
      const hits: SessionHit[] = []
      const r = await searchFiles(files, "needle", {
        rg: mode === "rg" ? rg : null,
        texts,
        signal: new AbortController().signal,
        onHit: (h) => hits.push(h),
        max: 2,
      })
      expect(hits).toHaveLength(2)
      expect(r.capped).toBe(true)
    })
  }

  for (const mode of ["streamed", "rg"] as const) {
    it.skipIf(mode === "rg" && !rg)(`${mode}: at the cap, the newest sessions win`, async () => {
      const files = Array.from({ length: 6 }, (_, i) => ({
        agent: "claude" as const,
        sessionId: `n${i}`, // n0 is the newest
        file: file(`n${i}.jsonl`, [claudeUser("needle")]),
      }))
      const hits: SessionHit[] = []
      await searchFiles(files, "needle", {
        rg: mode === "rg" ? rg : null,
        texts,
        signal: new AbortController().signal,
        onHit: (h) => hits.push(h),
        max: 3,
      })
      expect(hits.map((h) => h.sessionId)).toEqual(["n0", "n1", "n2"])
    })

    it.skipIf(mode === "rg" && !rg)(
      `${mode}: the words after hundreds of tool lines with them`,
      async () => {
        const lines = [
          ...Array(300).fill(claudeTool("running the flaky test")),
          claudeUser("fix the flaky test"),
        ]
        const f = { agent: "claude" as const, sessionId: "t", file: file("t.jsonl", lines) }
        const hits: SessionHit[] = []
        await searchFiles([f], "flaky test", {
          rg: mode === "rg" ? rg : null,
          texts,
          signal: new AbortController().signal,
          onHit: (h) => hits.push(h),
        })
        expect(hits.map((h) => h.snippet)).toEqual(["fix the flaky test"])
      },
    )
  }

  it("an rg that fails: every file is checked anyway", async () => {
    const hits: SessionHit[] = []
    await searchFiles(fixtures(), '"x"', {
      rg: path.join(dir, "no-such-rg"),
      texts,
      signal: new AbortController().signal,
      onHit: (h) => hits.push(h),
    })
    expect(hits.map((h) => h.sessionId).sort()).toEqual(["a", "c"])
  })

  it("ignores the case of letters beyond ASCII too", async () => {
    const f = {
      agent: "claude" as const,
      sessionId: "u",
      file: file("u.jsonl", [claudeUser("über die Brücke, ПРИВЕТ")]),
    }
    for (const q of ["ÜBER", "brücke", "привет"]) {
      const hits: SessionHit[] = []
      await searchFiles([f], q, {
        rg: null,
        texts,
        signal: new AbortController().signal,
        onHit: (h) => hits.push(h),
      })
      expect(hits).toHaveLength(1)
    }
  })

  for (const mode of ["streamed", "rg"] as const) {
    it.skipIf(mode === "rg" && !rg)(
      `${mode}: words across a line break, hyphens, double spaces`,
      async () => {
        const f = {
          agent: "claude" as const,
          sessionId: "w",
          file: file("w.jsonl", [claudeUser("please fix the\nquit-drain bug")]),
        }
        for (const q of ["the quit-drain", "fix  the", "QUIT-DRAIN bug"]) {
          const hits: SessionHit[] = []
          await searchFiles([f], q, {
            rg: mode === "rg" ? rg : null,
            texts,
            signal: new AbortController().signal,
            onHit: (h) => hits.push(h),
          })
          expect(hits, q).toHaveLength(1)
        }
      },
    )
  }

  it.skipIf(!rg)("rg in batches: more files than one command line takes", async () => {
    const files = Array.from({ length: 450 }, (_, i) => ({
      agent: "claude" as const,
      sessionId: `b${i}`,
      file: file(`b${i}.jsonl`, [claudeUser(i === 420 ? "the needle" : "hay")]),
    }))
    const hits: SessionHit[] = []
    await searchFiles(files, "needle", {
      rg,
      texts,
      signal: new AbortController().signal,
      onHit: (h) => hits.push(h),
    })
    expect(hits.map((h) => h.sessionId)).toEqual(["b420"])
  })

  it("an rg that fails outright (exit 2, nothing found): every file is checked", async () => {
    const fake = path.join(dir, "rg-old")
    fs.writeFileSync(fake, "#!/bin/sh\necho 'rg: unknown flag' >&2\nexit 2\n", { mode: 0o755 })
    const hits: SessionHit[] = []
    await searchFiles(fixtures(), '"x"', {
      rg: fake,
      texts,
      signal: new AbortController().signal,
      onHit: (h) => hits.push(h),
    })
    expect(hits.map((h) => h.sessionId).sort()).toEqual(["a", "c"])
  })

  it("an rg that can't even start: every file is checked", async () => {
    const hits: SessionHit[] = []
    await searchFiles(fixtures(), '"x"', {
      rg: "", // spawn throws at once
      texts,
      signal: new AbortController().signal,
      onHit: (h) => hits.push(h),
    })
    expect(hits.map((h) => h.sessionId).sort()).toEqual(["a", "c"])
  })

  it("lines that can't hold what was written aren't parsed", async () => {
    const parsed: string[] = []
    const f = {
      agent: "claude" as const,
      sessionId: "q",
      file: file("q.jsonl", [claudeTool("needle"), claudeUser("needle")]),
    }
    const hits: SessionHit[] = []
    await searchFiles([f], "needle", {
      rg: null,
      texts: (a, o) => {
        parsed.push(JSON.stringify(o).slice(0, 20))
        return texts(a, o)
      },
      quick: (_a, raw) => !raw.includes("tool_result"),
      signal: new AbortController().signal,
      onHit: (h) => hits.push(h),
    })
    expect(parsed).toHaveLength(1)
    expect(hits).toHaveLength(1)
  })

  it("a file rg can't read doesn't throw away what it found in the others", async () => {
    const files = [
      ...fixtures(),
      { agent: "claude" as const, sessionId: "gone", file: path.join(dir, "gone.jsonl") },
    ]
    const hits: SessionHit[] = []
    await searchFiles(files, '"x"', {
      rg,
      texts,
      signal: new AbortController().signal,
      onHit: (h) => hits.push(h),
    })
    expect(hits.map((h) => h.sessionId).sort()).toEqual(["a", "c"])
  })

  it("a query under 2 characters, or cancelled, finds nothing", async () => {
    const hits: SessionHit[] = []
    const o = { texts, onHit: (h: SessionHit) => hits.push(h) }
    await searchFiles(fixtures(), "x", { ...o, signal: new AbortController().signal })
    const ctl = new AbortController()
    ctl.abort()
    await searchFiles(fixtures(), '"x"', { ...o, signal: ctl.signal })
    expect(hits).toEqual([])
  })

  it("streamed: finds a line that straddles two chunks", async () => {
    const filler = claudeTool("x".repeat(1000))
    const lines = Array.from({ length: 4200 }, () => filler) // ~4.3 MB: past the 4 MB chunk
    lines.splice(4090, 0, claudeUser("the needle across the cut " + "y".repeat(5000)))
    const f: SearchFile = { agent: "claude", sessionId: "big", file: file("big.jsonl", lines) }
    const hits: SessionHit[] = []
    await searchFiles([f], "NEEDLE ACROSS", {
      rg: null,
      texts,
      signal: new AbortController().signal,
      onHit: (h) => hits.push(h),
    })
    expect(hits.map((h) => h.sessionId)).toEqual(["big"])
  })

  it("the byte pattern escapes the query and ignores case", () => {
    const p = bytePattern('a.b (c) "d"')
    expect(p.flags).toBe("gi")
    expect(p.test('A.B (C) \\"D\\"')).toBe(true)
    p.lastIndex = 0
    expect(p.test("axb (c) d")).toBe(false)
  })

  it("searches the words as they're written on disk (escaped quotes)", () => {
    expect(onDisk('say "x"')).toBe('say \\"x\\"')
  })
})
