import { describe, it, expect } from "vitest"
import {
  tabTitle,
  tabTitleParts,
  shortCwd,
  cwdBasename,
  shellType,
  isCustomOscTitle,
  displaySessionTitle,
  sessionSubline,
} from "./session-label"
import type { Session, Tab } from "../types"

const home = "/Users/me"

const mk = (over: Partial<Session> = {}): Session => ({
  id: "s",
  title: "zsh",
  command: "/bin/zsh",
  args: [],
  status: "idle",
  unread: false,
  ...over,
})
const tab = (title: string, activeSessionId = "s"): Tab => ({
  id: "t",
  title,
  root: { type: "leaf", id: "p", sessionIds: [activeSessionId], activeSessionId },
  activeSessionId,
})

describe("shellType", () => {
  it("derives a short badge label from the command", () => {
    expect(shellType("/bin/zsh")).toBe("zsh")
    expect(shellType("/usr/bin/bash")).toBe("bash")
    expect(shellType("powershell.exe")).toBe("pwsh")
    expect(shellType("C:\\Windows\\System32\\cmd.exe")).toBe("cmd")
    expect(shellType("wsl.exe")).toBe("wsl")
    expect(shellType("")).toBe("shell")
  })
})

describe("cwdBasename", () => {
  it("returns the last segment, ~ for home, empty for none", () => {
    expect(cwdBasename("/Users/me/src/term", home)).toBe("term")
    expect(cwdBasename("/Users/me", home)).toBe("~")
    expect(cwdBasename(undefined, home)).toBe("")
  })
})

describe("isCustomOscTitle", () => {
  it("rejects shell-default noise, accepts real titles", () => {
    expect(isCustomOscTitle("haquangle@Has-MacBook-Pro:~/workspace/term")).toBe(false)
    expect(isCustomOscTitle("~/workspace/term")).toBe(false)
    expect(isCustomOscTitle("src/auth/session.ts")).toBe(false)
    expect(isCustomOscTitle("Explore hexgate repos")).toBe(true)
    expect(isCustomOscTitle("")).toBe(false)
    expect(isCustomOscTitle(undefined)).toBe(false)
  })
})

describe("displaySessionTitle", () => {
  it("prefers a custom program title", () => {
    expect(displaySessionTitle(mk({ oscTitle: "Explore hexgate", cwd: "/Users/me/x" }), home)).toBe(
      "Explore hexgate",
    )
  })
  it("ignores noisy OSC titles and uses the cwd basename", () => {
    expect(displaySessionTitle(mk({ oscTitle: "me@host:~/x", cwd: "/Users/me/term" }), home)).toBe(
      "term",
    )
  })
  it("falls back to shell type when there's no cwd", () => {
    expect(displaySessionTitle(mk({ command: "/bin/bash" }), home)).toBe("bash")
  })
})

describe("tabTitle", () => {
  it("uses the manual pin when set, else the focused pane's display title", () => {
    expect(tabTitle(tab("Build"), { s: mk({ cwd: "/Users/me/term" }) }, home)).toBe("Build")
    expect(tabTitle(tab(""), { s: mk({ cwd: "/Users/me/term" }) }, home)).toBe("term")
  })
})

describe("shortCwd / sessionSubline", () => {
  it("home-relative cwd", () => {
    expect(shortCwd("/Users/me/term", home)).toBe("~/term")
    expect(shortCwd("/etc", home)).toBe("/etc")
  })
  it("joins branch and dir", () => {
    expect(sessionSubline("/Users/me/term", home, "main")).toBe("main • ~/term")
    expect(sessionSubline(undefined, home, "main")).toBe("main")
  })
})

describe("displaySessionTitle — ssh sessions", () => {
  const remote = { hostId: "native:gpu", label: "gpu box", target: "gpu", env: "native" as const }

  it("shows the host label, unless the program set a custom title", () => {
    expect(displaySessionTitle(mk({ command: "ssh", remote }), home)).toBe("gpu box")
    // the remote shell's default "user@host: ~/dir" isn't custom — the host label wins
    expect(
      displaySessionTitle(mk({ command: "ssh", remote, oscTitle: "me@gpu: ~/src" }), home),
    ).toBe("gpu box")
    expect(
      displaySessionTitle(mk({ command: "ssh", remote, oscTitle: "Fix the build" }), home),
    ).toBe("Fix the build")
  })
})

describe("tabTitle — tabs that span hosts", () => {
  const sess = (id: string, remote?: string): Session => ({
    id,
    title: "",
    command: remote ? "ssh" : "/bin/zsh",
    args: [],
    status: "idle",
    unread: false,
    ...(remote
      ? {
          remote: {
            hostId: `native:${remote}`,
            label: remote,
            target: remote,
            env: "native" as const,
          },
        }
      : {}),
  })
  const tabOf = (ids: string[], active: string, title = ""): Tab => ({
    id: "t",
    title,
    activeSessionId: active,
    root: { type: "leaf", id: "p", sessionIds: ids, activeSessionId: active },
  })

  it("one host: just the host", () => {
    const sessions = { a: sess("a", "gpu"), b: sess("b", "gpu") }
    expect(tabTitle(tabOf(["a", "b"], "a"), sessions, "/home/me")).toBe("gpu")
  })

  it("two hosts, or a host and this machine: the focused pane + how many other places", () => {
    const sessions = { a: sess("a", "gpu"), b: sess("b", "staging"), c: sess("c") }
    expect(tabTitle(tabOf(["a", "b"], "b"), sessions, "/home/me")).toBe("staging +1")
    expect(tabTitle(tabOf(["a", "b", "c"], "a"), sessions, "/home/me")).toBe("gpu +2")
  })

  it("local-only tabs and pinned titles are unchanged", () => {
    const sessions = { c: sess("c"), d: sess("d"), a: sess("a", "gpu") }
    expect(tabTitle(tabOf(["c", "d"], "c"), sessions, "/home/me")).toBe("zsh")
    expect(tabTitle(tabOf(["a", "c"], "a", "work"), sessions, "/home/me")).toBe("work")
  })
})

describe("tabTitleParts", () => {
  it("keeps the +N apart so a long title can ellipsize without losing it", () => {
    const remote = (h: string) => ({
      hostId: `native:${h}`,
      label: h,
      target: h,
      env: "native" as const,
    })
    const sessions: Record<string, Session> = {
      a: {
        id: "a",
        title: "",
        command: "ssh",
        args: [],
        status: "idle",
        unread: false,
        remote: remote("prod-db-replica-eu-west-1"),
      },
      b: {
        id: "b",
        title: "",
        command: "ssh",
        args: [],
        status: "idle",
        unread: false,
        remote: remote("staging"),
      },
    }
    const tab: Tab = {
      id: "t",
      title: "",
      activeSessionId: "a",
      root: { type: "leaf", id: "p", sessionIds: ["a", "b"], activeSessionId: "a" },
    }
    expect(tabTitleParts(tab, sessions, "/h")).toEqual({
      base: "prod-db-replica-eu-west-1",
      more: "+1",
    })
    expect(tabTitleParts({ ...tab, title: "pinned" }, sessions, "/h")).toEqual({ base: "pinned" })
  })
})
