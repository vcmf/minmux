import { describe, it, expect } from "vitest"
import { nextGitPollDelay, GIT_POLL_MS } from "./git-poll"

describe("nextGitPollDelay", () => {
  it("a fast repo polls every 2.5 s; a slow one waits 4× its cost, at most 30 s", () => {
    expect(nextGitPollDelay(20)).toBe(GIT_POLL_MS)
    expect(nextGitPollDelay(1000)).toBe(4000)
    expect(nextGitPollDelay(4200)).toBe(16800)
    expect(nextGitPollDelay(60_000)).toBe(30_000)
  })
})
