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

describe.skipIf(!hasGit)(
  "gitStatus — an untracked folder (e.g. an un-ignored node_modules)",
  () => {
    let dir = ""
    const git = (...a: string[]) => execFileSync("git", a, { cwd: dir, stdio: "ignore" })
    const commit = (m: string) =>
      git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", m)
    beforeAll(() => {
      dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "minmux-untracked-")))
      git("init", "-q", "-b", "main")
      fs.writeFileSync(path.join(dir, ".gitignore"), ".env\n")
      fs.writeFileSync(path.join(dir, "tracked.txt"), "a\n")
      fs.mkdirSync(path.join(dir, "sub"))
      fs.writeFileSync(path.join(dir, "sub", "kept.txt"), "k\n")
      git("add", ".")
      commit("init")
      fs.writeFileSync(path.join(dir, "tracked.txt"), "a\nb\n")
      const nm = path.join(dir, "docs", "node_modules", ".pnpm")
      fs.mkdirSync(nm, { recursive: true })
      for (let i = 0; i < 300; i++) fs.writeFileSync(path.join(nm, `f${i}.js`), "x\n")
      fs.writeFileSync(path.join(dir, "docs", "README.md"), "1\n2\n3\n")
      fs.writeFileSync(path.join(dir, "docs", ".env"), "SECRET=1\n") // ignored
      fs.writeFileSync(path.join(dir, "sub", "new.txt"), "1\n2\n")
    })
    afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))

    it("is reported once as a folder, not file by file; tracked changes still listed", async () => {
      const st = await gitStatus(dir)
      const paths = st.files.map((f) => `${f.path}${f.isDir ? "/" : ""}`)
      expect(paths.sort()).toEqual(["docs/", "sub/new.txt", "tracked.txt"])
      expect(st.files.find((f) => f.isDir)?.add).toBe(0) // a folder is never line-counted
    })

    it("from a terminal in a subfolder, untracked counts still resolve from the repo root", async () => {
      const st = await gitStatus(path.join(dir, "sub"))
      expect(st.files.find((f) => f.path === "sub/new.txt")?.add).toBe(2)
    })

    it("an untracked symlink to a device (/dev/zero) is never read (no hang, no OOM)", async () => {
      if (process.platform === "win32") return
      fs.symlinkSync("/dev/zero", path.join(dir, "zero"))
      const t0 = Date.now()
      const st = await gitStatus(dir)
      expect(Date.now() - t0).toBeLessThan(5000)
      expect(st.files.find((f) => f.path === "zero")?.add).toBe(1) // one line (the link), target unread
      fs.rmSync(path.join(dir, "zero"))
    })
  },
)

describe.skipIf(!hasGit)("gitDiff in a repo with no commits yet", () => {
  it("diffs a new file against the null device instead of returning nothing", async () => {
    const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "minmux-nohead-")))
    try {
      execFileSync("git", ["init", "-q", "-b", "main"], { cwd: d })
      fs.mkdirSync(path.join(d, "d"))
      fs.writeFileSync(path.join(d, "d", "f"), "one\ntwo\n")
      const diff = await gitDiff(d, "d/f")
      expect(diff.filter((l) => l.type === "add").map((l) => l.text)).toEqual(["one", "two"])
    } finally {
      fs.rmSync(d, { recursive: true, force: true })
    }
  })
})

describe.skipIf(!hasGit)("gitDiff is bounded and honest", () => {
  let d = ""
  const git = (...a: string[]) => execFileSync("git", a, { cwd: d, stdio: "ignore" })
  beforeAll(() => {
    d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "minmux-diff-")))
    git("init", "-q", "-b", "main")
    fs.writeFileSync(path.join(d, "t.txt"), "same\n")
    git("add", "t.txt")
    git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "t")
  })
  afterAll(() => fs.rmSync(d, { recursive: true, force: true }))

  it("a tracked file that matches HEAD is not shown as wholly added", async () => {
    fs.writeFileSync(path.join(d, "t.txt"), "changed\n")
    git("add", "t.txt")
    fs.writeFileSync(path.join(d, "t.txt"), "same\n") // staged change, worktree back to HEAD
    expect(await gitDiff(d, "t.txt")).toEqual([])
  })

  it.skipIf(process.platform === "win32")(
    "a symlink to a FIFO ends with a note instead of hanging git",
    async () => {
      execFileSync("mkfifo", [path.join(d, "fifo")])
      fs.symlinkSync(path.join(d, "fifo"), path.join(d, "lnk"))
      const out = await gitDiff(d, "lnk")
      // Either git diffs the link text, or it reads the pipe and our timeout cuts it off.
      expect(out.length).toBeGreaterThan(0)
    },
    20_000,
  )
})
