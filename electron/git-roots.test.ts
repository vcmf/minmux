import { describe, expect, it, vi } from "vitest"
import { findGitRoots, type SearchFn } from "./git-roots"
import { MAX_GIT_ROOTS } from "../src/lib/pane-git"

const share = (form: number) => (form ? "\\\\wsl$\\U" : "\\\\wsl.localhost\\U")
const targets = (d: string) => [0, 1].map((f) => share(f) + d.replace(/\//g, "\\"))

describe("findGitRoots", () => {
  it("host folders: one search, symlinks resolved", async () => {
    const search = vi.fn<SearchFn>(async () => ({ "/r/src": "/r", "/x": null }))
    expect(await findGitRoots([{ dir: "/r/src" }, { dir: "/x" }], search, targets)).toEqual({
      "/r/src": "/r",
      "/x": null,
    })
    expect(search).toHaveBeenCalledWith(["/r/src", "/x"], true)
  })

  it("a folder tab's host folders: their own spelling, symlinks kept", async () => {
    const search = vi.fn<SearchFn>(async (_paths, real): Promise<Record<string, string | null>> =>
      real ? { "/r/src": "/private/r" } : { "/r/tab": "/r" },
    )
    const out = await findGitRoots(
      [{ dir: "/r/src" }, { dir: "/r/tab", spelled: true }],
      search,
      targets,
    )
    expect(out).toEqual({ "/r/src": "/private/r", "/r/tab": "/r" })
    expect(search).toHaveBeenCalledWith(["/r/tab"], false)
  })

  it("a WSL folder: through its share, mapped back; the next form for those left", async () => {
    const wsl = { distro: "U" }
    const search = vi.fn<SearchFn>(async (paths) => {
      if (paths[0]!.startsWith(share(0))) return { [targets("/home/a")[0]!]: share(0) + "\\home" }
      return { [targets("/home/b")[1]!]: null }
    })
    const out = await findGitRoots(
      [
        { dir: "/home/a", wsl },
        { dir: "/home/b", wsl },
      ],
      search,
      targets,
    )
    expect(out).toEqual({ "/home/a": "/home", "/home/b": null })
    expect(search).toHaveBeenCalledTimes(2)
    expect(search.mock.calls[0]![1]).toBe(false) // a share's spelling isn't resolved
    expect(search.mock.calls[1]![0]).toEqual([targets("/home/b")[1]])
  })

  it("a WSL folder with no share path (its distro unknown) is left to git", async () => {
    const search = vi.fn<SearchFn>(async () => ({ "/home/a": null }))
    expect(await findGitRoots([{ dir: "/home/a", wsl: {} }], search, (d) => [d])).toEqual({})
    expect(search).not.toHaveBeenCalled()
  })

  it("a host root in git's spelling (C:/x, not C:\\x)", async () => {
    const search = vi.fn<SearchFn>(async () => ({ "C:\\r\\src": "C:\\r", "/x": "/x" }))
    expect(await findGitRoots([{ dir: "C:\\r\\src" }, { dir: "/x" }], search, targets)).toEqual({
      "C:\\r\\src": "C:/r",
      "/x": "/x",
    })
  })

  it("a hung or busy search: those folders fail, the next form isn't tried", async () => {
    const search = vi.fn<SearchFn>(async () => {
      throw Object.assign(new Error("EHUNG"), { code: "EHUNG" })
    })
    expect(await findGitRoots([{ dir: "/h", wsl: {} }, { dir: "/r" }], search, targets)).toEqual({})
    expect(search).toHaveBeenCalledTimes(2) // host + one WSL form
  })

  it("bounded", async () => {
    const search = vi.fn<SearchFn>(async () => ({}))
    const reqs = Array.from({ length: MAX_GIT_ROOTS + 5 }, (_, i) => ({ dir: `/d${i}` }))
    await findGitRoots(reqs, search, targets)
    expect(search.mock.calls[0]![0]).toHaveLength(MAX_GIT_ROOTS)
  })
})
