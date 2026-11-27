import { describe, expect, it } from "vitest"
import { answerKeys, parseDialog } from "./answers"

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
      question: "Do you want to proceed?",
      options: [
        { n: 1, label: "Yes" },
        { n: 2, label: "Yes, and don't ask again for rm" },
        { n: 3, label: "No, and tell Claude what to do" },
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
    expect(parseDialog(lines)?.options.map((o) => o.label)).toEqual(["Staging", "Production"])
  })

  it("nothing that isn't a dialog: no options, numbering that doesn't start at 1, no question", () => {
    expect(parseDialog(["$ ls", "a b c"])).toBeNull()
    expect(parseDialog(["Pick?", "  2. b", "  3. c"])).toBeNull()
    expect(parseDialog(["  1. a", "  2. b"])).toBeNull()
    expect(parseDialog(["Pick?", "  1. a", "  3. c"])).toBeNull()
  })
})

describe("answerKeys", () => {
  it("Claude takes the option's number; others aren't typed into", () => {
    expect(answerKeys("claude", 2)).toBe("2")
    expect(answerKeys(undefined, 1)).toBe("1")
    expect(answerKeys("codex", 1)).toBeNull()
    expect(answerKeys("claude", 0)).toBeNull()
  })
})
