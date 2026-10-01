import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { gitStatus, gitDiff } from "./git"

// Real-git integration: build a throwaway repo and exercise gitStatus/gitDiff
// end-to-end (the pure parsers are covered separately in git.test.ts).

const hasGit = (() => {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" })
    return true
  } catch {
    return false
  }
})()

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "pipe" })

describe.skipIf(!hasGit)("git module (real repo)", () => {
  let repo = ""
  let plain = ""
  const savedGit: Record<string, string | undefined> = {}

  beforeAll(() => {
    // Isolate from ambient git state before touching any repo. This matters most
    // when the suite runs from a git hook (e.g. pre-push): hooks export GIT_DIR /
    // GIT_INDEX_FILE / GIT_WORK_TREE pointing at the REAL repo, which our child
    // `git` (and gitStatus/gitDiff, which inherit process.env) would otherwise use
    // instead of the throwaway repo below — making `git commit` fail. Also ignore
    // system config. Identity, no-gpg, and no ambient hooks are set on the repo.
    for (const k of Object.keys(process.env)) {
      if (k.startsWith("GIT_")) {
        savedGit[k] = process.env[k]
        delete process.env[k]
      }
    }
    process.env.GIT_CONFIG_NOSYSTEM = "1"

    repo = fs.mkdtempSync(path.join(os.tmpdir(), "minmux-git-"))
    git(repo, "-c", "init.defaultBranch=main", "init")
    git(repo, "config", "user.email", "t@t.dev")
    git(repo, "config", "user.name", "Test")
    git(repo, "config", "commit.gpgsign", "false")
    // Neutralize any global core.hooksPath so the commit doesn't run ambient hooks.
    git(repo, "config", "core.hooksPath", path.join(repo, ".git", "no-such-hooks"))
    fs.writeFileSync(path.join(repo, "a.txt"), "line1\nline2\nline3\n")
    git(repo, "add", "a.txt")
    git(repo, "commit", "-m", "init")
    // Modify a tracked file (1 del + 1 add) and add an untracked file.
    fs.writeFileSync(path.join(repo, "a.txt"), "line1\nline2-changed\nline3\n")
    fs.writeFileSync(path.join(repo, "new.txt"), "hello\nworld\n")

    plain = fs.mkdtempSync(path.join(os.tmpdir(), "minmux-plain-"))
  })

  afterAll(() => {
    // Restore the git env we scrubbed so we don't leak into other suites.
    delete process.env.GIT_CONFIG_NOSYSTEM
    for (const [k, v] of Object.entries(savedGit)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    for (const d of [repo, plain]) if (d) fs.rmSync(d, { recursive: true, force: true })
  })

  it("reports branch + changed files with +/- counts", async () => {
    const s = await gitStatus(repo)
    expect(s.isRepo).toBe(true)
    expect(s.branch).toBe("main")

    const modified = s.files.find((f) => f.path === "a.txt")
    expect(modified).toMatchObject({ status: "M", add: 1, del: 1 })

    const untracked = s.files.find((f) => f.path === "new.txt")
    expect(untracked?.status).toBe("?")
    expect(untracked?.add).toBeGreaterThan(0)

    expect(s.add).toBeGreaterThanOrEqual(1)
    expect(s.del).toBe(1)
  })

  it("produces a unified diff for a modified file", async () => {
    const lines = await gitDiff(repo, "a.txt")
    expect(lines.some((l) => l.type === "hunk")).toBe(true)
    expect(lines.some((l) => l.type === "del" && l.text === "line2")).toBe(true)
    expect(lines.some((l) => l.type === "add" && l.text === "line2-changed")).toBe(true)
    expect(lines.some((l) => l.type === "context" && l.text === "line1")).toBe(true)
  })

  it("produces an all-additions diff for an untracked file", async () => {
    const lines = await gitDiff(repo, "new.txt")
    const adds = lines.filter((l) => l.type === "add").map((l) => l.text)
    expect(adds).toEqual(expect.arrayContaining(["hello", "world"]))
  })

  it("returns isRepo:false for a non-git directory", async () => {
    expect((await gitStatus(plain)).isRepo).toBe(false)
    expect(await gitDiff(plain, "whatever")).toEqual([])
  })

  it("returns isRepo:false for an empty cwd", async () => {
    expect((await gitStatus("")).isRepo).toBe(false)
  })
})

describe("gitStatus — an untracked folder (e.g. an un-ignored node_modules)", () => {
  it("is reported once as a folder, not file by file; tracked changes still listed", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "minmux-untracked-"))
    const git = (...a: string[]) => execFileSync("git", a, { cwd: dir, stdio: "ignore" })
    git("init", "-q", "-b", "main")
    git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init")
    fs.writeFileSync(path.join(dir, "tracked.txt"), "a\n")
    git("add", "tracked.txt")
    git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "t")
    fs.writeFileSync(path.join(dir, "tracked.txt"), "a\nb\n")
    const nm = path.join(dir, "docs", "node_modules", ".pnpm")
    fs.mkdirSync(nm, { recursive: true })
    for (let i = 0; i < 300; i++) fs.writeFileSync(path.join(nm, `f${i}.js`), "x\n")
    const st = await gitStatus(dir)
    const paths = st.files.map((f) => `${f.path}${f.isDir ? "/" : ""}`)
    expect(paths.sort()).toEqual(["docs/", "tracked.txt"])
    expect(st.files.find((f) => f.isDir)?.add).toBe(0) // a folder is never line-counted
    fs.rmSync(dir, { recursive: true, force: true })
  })
})
