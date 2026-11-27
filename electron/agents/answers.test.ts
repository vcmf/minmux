import { describe, expect, it } from "vitest"
import { answerKeys, dialogSignature, parseDialog } from "./answers"

const claudePermission = [
  "⏺ Bash(rm -rf build)",
  "╭────────────────────────────────────────────╮",
  "│ Bash command                               │",
  "│                                            │",
  "│   rm -rf build                             │",
  "│                                            │",
  "│ Do you want to proceed?                    │",
  "│ ❯ 1. Yes                                   │",
  "│   2. Yes, and don't ask again for rm       │",
  "│      commands in /repo                     │",
  "│   3. No, and tell Claude what to do        │",
  "│      differently (esc)                     │",
  "╰────────────────────────────────────────────╯",
]

describe("parseDialog", () => {
  it("reads Claude's permission prompt: question and options, by number", () => {
    expect(parseDialog(claudePermission)).toEqual({
      kind: "permission",
      question: "Do you want to proceed?",
      body: ["Bash command", "rm -rf build"], // what it asks about: shown on the phone
      options: [
        { n: 1, label: "Yes" },
        // A wrapped label is kept whole: the phone shows the full scope it grants.
        { n: 2, label: "Yes, and don't ask again for rm commands in /repo" },
        { n: 3, label: "No, and tell Claude what to do differently (esc)" },
      ],
    })
  })

  it("reads a question with descriptions under its options", () => {
    const lines = [
      "Which deploy target?",
      "",
      "› 1. Staging",
      "     Safe first",
      "  2. Production",
      "     Careful",
      "",
      "Enter to select · Esc to cancel",
    ]
    const d = parseDialog(lines)!
    expect(d.kind).toBe("question") // not a go-ahead prompt: never answered by a digit
    expect(d.options.map((o) => o.label)).toEqual(["Staging Safe first", "Production Careful"])
    expect(d.body).toEqual([]) // no box: nothing unrelated above it
  })

  it("a numbered list higher up isn't joined to a dialog whose option 1 scrolled away", () => {
    const lines = [
      "Which approach?",
      "1. Refactor",
      "",
      "Do you want to proceed?",
      "  2. b",
      "  3. c",
    ]
    expect(parseDialog(lines)).toBeNull()
  })

  it("nothing that isn't a dialog: no options, numbering that doesn't start at 1, no question", () => {
    expect(parseDialog(["$ ls", "a b c"])).toBeNull()
    expect(parseDialog(["Pick?", "  2. b", "  3. c"])).toBeNull()
    expect(parseDialog(["  1. a", "  2. b"])).toBeNull()
    expect(parseDialog(["Pick?", "  1. a", "  3. c"])).toBeNull()
  })
})

describe("dialogSignature", () => {
  it("tells apart two prompts that ask the same question about different commands", () => {
    const a = parseDialog(claudePermission)!
    const b = parseDialog(claudePermission.map((l) => l.replace("rm -rf build", "rm -rf dist ")))!
    expect(a.question).toBe(b.question)
    expect(dialogSignature(a)).not.toBe(dialogSignature(b))
  })
})

describe("answerKeys", () => {
  it("Claude's permission prompts take the option's number; nothing else is typed into", () => {
    expect(answerKeys("claude", "permission", 2)).toBe("2")
    expect(answerKeys(undefined, "permission", 1)).toBeNull() // unknown agent: never assumed
    expect(answerKeys("codex", "permission", 1)).toBeNull()
    expect(answerKeys("claude", "question", 1)).toBeNull() // a digit only picks there
    expect(answerKeys("claude", "permission", 0)).toBeNull()
  })
})
