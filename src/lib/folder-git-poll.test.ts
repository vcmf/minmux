import { describe, it, expect, beforeEach, vi } from "vitest"
import { wantGit } from "./folder-git-poll"
import { repoKey, wantKey } from "./folder-git"
import { ipc } from "./ipc"
import { useStore } from "../store"
import { resetStore } from "../test/helpers"
import type { GitStatus } from "./ipc"

const repo = (root: string): GitStatus =>
  ({
    isRepo: true,
    root,
    branch: "main",
    ahead: 0,
    behind: 0,
    files: [],
    add: 0,
    del: 0,
  }) as GitStatus
const notRepo = { isRepo: false, root: "" } as GitStatus

// Let the loop run its ticks: each awaits IPC, then waits ≥ 3 s.
const ticks = async (n: number) => {
  for (let i = 0; i < n; i++) {
    await vi.advanceTimersByTimeAsync(3100)
  }
}

describe("folder git poll", () => {
  beforeEach(() => {
    resetStore()
    vi.useFakeTimers()
    vi.clearAllMocks()
  })

  it("learns each folder's root, polls its repo, and stores the status under it", async () => {
    vi.mocked(ipc.gitRoots).mockResolvedValue({ "/a/src": "/a" })
    vi.mocked(ipc.gitStatus).mockResolvedValue(repo("/private/a")) // git's own spelling
    wantGit("v1", { path: "/a/src" })
    await ticks(1)
    const s = useStore.getState()
    expect(s.folderRoots[wantKey({ path: "/a/src" })]).toBe("/a")
    expect(s.folderGit[repoKey(undefined, "/a")]!.root).toBe("/a") // the folder's spelling
    wantGit("v1", null)
    await ticks(1)
    expect(useStore.getState().folderGit).toEqual({}) // nothing shown: nothing kept
  })

  it("a repo whose status keeps failing doesn't take every tick from the others", async () => {
    vi.mocked(ipc.gitRoots).mockResolvedValue({ "/big": "/big", "/b": "/b" })
    vi.mocked(ipc.gitStatus).mockImplementation(async (cwd: string) =>
      cwd === "/big" ? notRepo : repo("/b"),
    )
    wantGit("v1", { path: "/big" })
    wantGit("v2", { path: "/b" })
    await ticks(4)
    const asked = vi.mocked(ipc.gitStatus).mock.calls.map((c) => c[0])
    expect(asked).toContain("/b")
    expect(useStore.getState().folderGit[repoKey(undefined, "/b")]).toBeDefined()
    wantGit("v1", null)
    wantGit("v2", null)
    await ticks(1)
  })

  it("skips the focused terminal's repo: its own poll covers it", async () => {
    useStore.setState({ git: repo("/f") })
    vi.mocked(ipc.gitRoots).mockResolvedValue({ "/f/x": "/f" })
    wantGit("v1", { path: "/f/x" })
    await ticks(2)
    expect(ipc.gitStatus).not.toHaveBeenCalled()
    wantGit("v1", null)
    await ticks(1)
  })

  it("a folder in no repo is never polled", async () => {
    vi.mocked(ipc.gitRoots).mockResolvedValue({ "/tmp/x": null })
    wantGit("v1", { path: "/tmp/x" })
    await ticks(2)
    expect(ipc.gitStatus).not.toHaveBeenCalled()
    expect(useStore.getState().folderRoots[wantKey({ path: "/tmp/x" })]).toBeNull()
    wantGit("v1", null)
    await ticks(1)
  })
})
