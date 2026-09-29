import path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { RemoteRef } from "../src/types"
import { SshService, type SshDeps } from "./ssh-service"
import { keepAliveFlags } from "./ssh-hosts"
import type { MiniFs } from "./ssh-config"

const HOME = "/Users/me"
const SSH = "/usr/bin/ssh"
const KA = keepAliveFlags(30)

/** An in-memory MiniFs over a path → text map (dirs implied), counting reads. */
function memFs(files: Record<string, string>, p = path.posix): MiniFs & { reads: string[] } {
  const reads: string[] = []
  return {
    reads,
    readFile: async (f) => {
      reads.push(f)
      return Object.prototype.hasOwnProperty.call(files, f) ? files[f]! : null
    },
    readdir: async (dir) => {
      const prefix = dir.endsWith(p.sep) ? dir : dir + p.sep
      const names = new Set<string>()
      for (const f of Object.keys(files))
        if (f.startsWith(prefix)) names.add(f.slice(prefix.length).split(p.sep)[0]!)
      return names.size ? [...names] : null
    },
  }
}

interface Harness {
  deps: SshDeps
  svc: SshService
  watchCalls: { paths: string[]; fire: (path: string) => void; closed: boolean }[]
  watchers: { sets: string[][]; closed: boolean }[]
  onChange: ReturnType<typeof vi.fn>
}

function harness(
  over: Partial<SshDeps> = {},
  opts: { config?: string; settings?: unknown } = {},
): Harness {
  const watchCalls: Harness["watchCalls"] = []
  const watchers: { sets: string[][]; closed: boolean }[] = []
  const onChange = vi.fn()
  const deps: SshDeps = {
    platform: "darwin",
    home: HOME,
    readSettings: () => JSON.stringify(opts.settings ?? {}),
    fs: memFs({
      [`${HOME}/.ssh/config`]: opts.config ?? "Host web\n  HostName 10.0.0.1\nHost db\n",
    }),
    wslRunningDistros: async () => [],
    wslHome: async () => null,
    wslFs: () => memFs({}),
    wslWatchPaths: (d, p) => [`\\\\wsl.localhost\\${d}${p.replace(/\//g, "\\")}`],
    sshPath: async () => SSH,
    sshEffectiveConfig: async () => "user me\nhostname 10.0.0.1\n",
    // One long-lived watcher: each set() is recorded (the paths watched from then on).
    createWatcher: (fire) => {
      const w = { sets: [] as string[][], closed: false }
      watchers.push(w)
      return {
        set: (paths) => {
          w.sets.push(paths)
          watchCalls.push({ paths, fire, closed: false })
        },
        close: () => {
          w.closed = true
          for (const c of watchCalls) c.closed = true
        },
      }
    },
    onChange,
    ...over,
  }
  return { deps, svc: new SshService(deps), watchCalls, watchers, onChange }
}

const web: RemoteRef = { hostId: "native:web", label: "web", target: "web", env: "native" }

/** The hosts the UI offers: main lists hidden ones too, flagged (to show them again). */
const shown = (hosts: { hostId: string; hidden?: true }[]) => hosts.filter((h) => !h.hidden)

describe("SshService.hosts", () => {
  it("lists ~/.ssh/config hosts with their details", async () => {
    const { svc } = harness()
    expect(await svc.hosts()).toEqual([
      {
        hostId: "native:web",
        label: "web",
        target: "web",
        env: "native",
        detail: "10.0.0.1",
      },
      { hostId: "native:db", label: "db", target: "db", env: "native" },
    ])
  })

  it("flags hidden hosts, case-insensitively (listed, so they can be shown again)", async () => {
    const { svc } = harness({}, { settings: { ssh: { hidden: ["DB"] } } })
    const hosts = await svc.hosts()
    expect(shown(hosts).map((h) => h.hostId)).toEqual(["native:web"])
    expect(hosts.find((h) => h.hostId === "native:db")?.hidden).toBe(true)
  })

  it("reads the config once until something changes", async () => {
    const h = harness()
    const fs = h.deps.fs as ReturnType<typeof memFs>
    await h.svc.hosts()
    await h.svc.hosts()
    expect(fs.reads.filter((r) => r.endsWith("/.ssh/config"))).toHaveLength(1)
    h.svc.invalidate()
    await h.svc.hosts()
    expect(fs.reads.filter((r) => r.endsWith("/.ssh/config"))).toHaveLength(2)
  })

  it("tolerates unreadable settings JSON (uses the defaults)", async () => {
    const { svc } = harness({ readSettings: () => "{not json" })
    expect(await svc.hosts()).toHaveLength(2)
  })

  it("lists WSL distros' hosts on Windows, skipping a distro that won't answer", async () => {
    const homes: string[] = []
    const { svc, watchCalls } = harness({
      platform: "win32",
      home: "C:\\Users\\me",
      fs: memFs({}, path.win32),
      wslRunningDistros: async () => [
        "Ubuntu",
        "Broken",
        "NoHome",
        "docker-desktop",
        "docker-desktop-data",
      ],
      wslHome: async (d) => {
        homes.push(d)
        return d === "Ubuntu" ? "/home/me" : d === "Broken" ? "/home/x" : null
      },
      wslFs: (d) => {
        if (d === "Broken") throw new Error("share gone")
        return memFs({ "/home/me/.ssh/config": "Host gpu\n" })
      },
    })
    expect((await svc.hosts()).map((h) => h.hostId)).toEqual(["wsl:Ubuntu:gpu"])
    expect(homes).not.toContain("docker-desktop")
    expect(homes).not.toContain("docker-desktop-data")
    expect(watchCalls.at(-1)!.paths).toContain("\\\\wsl.localhost\\Ubuntu\\home\\me\\.ssh\\config")
  })

  it("a slow distro makes the list partial after 5 s, while a pane waits out its full load", async () => {
    vi.useFakeTimers()
    try {
      let release!: () => void
      const booting = new Promise<void>((r) => (release = r))
      const timeouts: number[] = []
      const h = harness({
        platform: "win32",
        home: "C:\\Users\\me",
        fs: memFs({}, path.win32),
        wslRunningDistros: async () => ["Ubuntu"],
        wslHome: async (_d, t) => {
          timeouts.push(t)
          await booting
          return "/home/me"
        },
        wslFs: () => memFs({ "/home/me/.ssh/config": "Host box\n" }),
      })
      const listing = h.svc.hosts()
      const spawning = h.svc.spawnPlan({ hostId: "wsl:Ubuntu:box" })
      await vi.advanceTimersByTimeAsync(5100)
      expect(await listing).toEqual([]) // the list gave up waiting…
      release()
      expect(await spawning).toHaveProperty("file", "wsl.exe") // …the pane didn't
      expect(timeouts).toEqual([20_000]) // one shared load, with the full budget
      expect((await h.svc.hosts()).map((x) => x.hostId)).toEqual(["wsl:Ubuntu:box"])
    } finally {
      vi.useRealTimers()
    }
  })

  it("re-reads a distro's config after a while (watching \\\\wsl$ shares is unreliable)", async () => {
    vi.useFakeTimers()
    try {
      let config = "Host a\n"
      const h = harness({
        platform: "win32",
        home: "C:\\Users\\me",
        fs: memFs({}, path.win32),
        wslRunningDistros: async () => ["Ubuntu"],
        wslHome: async () => "/home/me",
        wslFs: () => ({ readFile: async () => config, readdir: async () => null }),
      })
      expect((await h.svc.hosts()).map((x) => x.label)).toEqual(["a"])
      config = "Host a\nHost b\n"
      await vi.advanceTimersByTimeAsync(31_000)
      h.svc.invalidate() // (the display list itself is rebuilt on the next change or reload)
      expect((await h.svc.hosts()).map((x) => x.label)).toEqual(["a", "b"])
    } finally {
      vi.useRealTimers()
    }
  })

  it("loads WSL distros in parallel (a slow one doesn't delay the others' start)", async () => {
    const started: string[] = []
    let release!: () => void
    const slow = new Promise<void>((r) => (release = r))
    const { svc } = harness({
      platform: "win32",
      home: "C:\\Users\\me",
      fs: memFs({}, path.win32),
      wslRunningDistros: async () => ["Slow", "Fast"],
      wslHome: async (d) => {
        started.push(d)
        if (d === "Slow") await slow
        return "/home/me"
      },
      wslFs: () => memFs({ "/home/me/.ssh/config": "Host h\n" }),
    })
    const listing = svc.hosts()
    await new Promise((r) => setTimeout(r, 0))
    expect(started).toEqual(["Slow", "Fast"])
    release()
    expect((await listing).map((h) => h.hostId)).toEqual(["wsl:Slow:h", "wsl:Fast:h"])
  })

  it("doesn't keep a list where a WSL distro didn't answer", async () => {
    let up = false
    const { svc } = harness({
      platform: "win32",
      home: "C:\\Users\\me",
      fs: memFs({}, path.win32),
      wslRunningDistros: async () => ["Ubuntu"],
      wslHome: async () => (up ? "/home/me" : null),
      wslFs: () => memFs({ "/home/me/.ssh/config": "Host box\n" }),
    })
    expect(await svc.hosts()).toEqual([])
    up = true
    expect((await svc.hosts()).map((h) => h.hostId)).toEqual(["wsl:Ubuntu:box"])
  })

  it("boots only a restored WSL pane's own distro, and says so if it doesn't answer", async () => {
    const asked: string[] = []
    let up = false
    const h = harness({
      platform: "win32",
      home: "C:\\Users\\me",
      fs: memFs({}, path.win32),
      wslRunningDistros: async () => [], // nothing running: the list never boots a VM
      wslHome: async (d) => {
        asked.push(d)
        return up ? "/home/me" : null
      },
      wslFs: () => memFs({ "/home/me/.ssh/config": "Host box\n" }),
    })
    expect(await h.svc.hosts()).toEqual([])
    expect(asked).toEqual([])
    const ref = { hostId: "wsl:Ubuntu:box" }
    expect(await h.svc.spawnPlan(ref)).toEqual({ error: expect.stringContaining("WSL (Ubuntu)") })
    up = true
    expect(await h.svc.spawnPlan(ref)).toHaveProperty("file", "wsl.exe") // retried, not cached
    expect(asked).toEqual(["Ubuntu", "Ubuntu"])
  })

  it("rebuilds the list when the set of running WSL distros changes", async () => {
    let running = ["Ubuntu"]
    const { svc } = harness({
      platform: "win32",
      home: "C:\\Users\\me",
      fs: memFs({}, path.win32),
      wslRunningDistros: async () => running,
      wslHome: async () => "/home/me",
      wslFs: (d) => memFs({ "/home/me/.ssh/config": `Host ${d.toLowerCase()}-box\n` }),
    })
    vi.useFakeTimers()
    expect((await svc.hosts()).map((h) => h.hostId)).toEqual(["wsl:Ubuntu:ubuntu-box"])
    running = ["Ubuntu", "Debian"]
    vi.advanceTimersByTime(6000) // past the running-distros cache
    expect((await svc.hosts()).map((h) => h.hostId)).toEqual([
      "wsl:Ubuntu:ubuntu-box",
      "wsl:Debian:debian-box",
    ])
    vi.useRealTimers()
  })

  it("forgets stale WSL watch paths on invalidate", async () => {
    const h = harness({
      platform: "win32",
      home: "C:\\Users\\me",
      fs: memFs({}, path.win32),
      wslRunningDistros: async () => ["Ubuntu"],
      wslHome: async () => "/home/me",
      wslFs: () => memFs({ "/home/me/.ssh/config": "Host b\n" }),
    })
    await h.svc.hosts()
    expect(h.watchCalls.at(-1)!.paths.some((p) => p.includes("Ubuntu"))).toBe(true)
    h.deps.wslRunningDistros = async () => []
    h.svc.invalidate()
    await h.svc.hosts()
    expect(h.watchCalls.at(-1)!.paths.some((p) => p.includes("Ubuntu"))).toBe(false)
  })

  it("refreshes the sidebar list after the WSL re-read window, even with the same distros running", async () => {
    vi.useFakeTimers()
    try {
      let config = "Host a\n"
      const h = harness({
        platform: "win32",
        home: "C:\\Users\\me",
        fs: memFs({}, path.win32),
        wslRunningDistros: async () => ["Ubuntu"],
        wslHome: async () => "/home/me",
        wslFs: () => ({ readFile: async () => config, readdir: async () => null }),
      })
      expect((await h.svc.hosts()).map((x) => x.label)).toEqual(["a"])
      config = "Host a\nHost b\n" // edited inside WSL; the \\wsl$ watcher missed it
      expect((await h.svc.hosts()).map((x) => x.label)).toEqual(["a"]) // cached for now
      await vi.advanceTimersByTimeAsync(31_000)
      expect((await h.svc.hosts()).map((x) => x.label)).toEqual(["a", "b"])
    } finally {
      vi.useRealTimers()
    }
  })

  it("doesn't cache a failed load", async () => {
    let fail = true
    const base = memFs({ [`${HOME}/.ssh/config`]: "Host a\n" })
    const { svc } = harness({
      fs: {
        readFile: async (p) => {
          if (fail) throw new Error("boom")
          return base.readFile(p)
        },
        readdir: base.readdir,
      },
    })
    await expect(svc.hosts()).rejects.toThrow("boom")
    fail = false
    expect((await svc.hosts()).map((h) => h.hostId)).toEqual(["native:a"])
  })
})

describe("SshService watching", () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it("watches every path the load tried and reloads when one changes", async () => {
    const h = harness({}, { config: "Include conf.d/*\nHost web\n" })
    await h.svc.hosts()
    const w = h.watchCalls.at(-1)!
    expect(w.paths).toEqual(expect.arrayContaining([`${HOME}/.ssh/config`, `${HOME}/.ssh/conf.d`]))
    w.fire(`${HOME}/.ssh/config`)
    await vi.advanceTimersByTimeAsync(250)
    expect(h.onChange).toHaveBeenCalledTimes(1)
    await h.svc.hosts()
    expect(h.watchers).toHaveLength(1) // one long-lived watcher, updated in place
    expect(h.watchers[0]!.closed).toBe(false)
    expect(h.watchers[0]!.sets.length).toBeGreaterThanOrEqual(2)
  })

  it("ignores unrelated files in a watched dir (ssh's own known_hosts writes)", async () => {
    const h = harness({}, { config: "Include ~/.ssh/*.conf\nHost web\n" })
    await h.svc.hosts()
    const w = h.watchCalls.at(-1)!
    expect(w.paths).toContain(`${HOME}/.ssh`)
    w.fire(`${HOME}/.ssh/known_hosts`)
    w.fire(`${HOME}/.ssh/known_hosts.old`)
    await vi.advanceTimersByTimeAsync(250)
    expect(h.onChange).not.toHaveBeenCalled()
    w.fire(`${HOME}/.ssh/work.conf`) // a new file the Include glob matches
    await vi.advanceTimersByTimeAsync(250)
    expect(h.onChange).toHaveBeenCalledTimes(1)
  })

  it("asks which WSL distros run at most every few seconds", async () => {
    let calls = 0
    const { svc } = harness({
      platform: "win32",
      home: "C:\\Users\\me",
      fs: memFs({}, path.win32),
      wslRunningDistros: async () => (calls++, []),
    })
    await svc.hosts()
    await svc.hosts()
    await svc.hosts()
    expect(calls).toBe(1)
    await vi.advanceTimersByTimeAsync(6000)
    await svc.hosts()
    expect(calls).toBe(2)
  })

  it("debounces a burst of changes into one notification", async () => {
    const h = harness()
    for (let i = 0; i < 5; i++) h.svc.invalidate()
    await vi.advanceTimersByTimeAsync(250)
    expect(h.onChange).toHaveBeenCalledTimes(1)
  })

  it("a load that was invalidated mid-flight doesn't install its watcher", async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const base = memFs({ [`${HOME}/.ssh/config`]: "Host a\n" })
    const h = harness({
      fs: { readFile: async (p) => (await gate, base.readFile(p)), readdir: base.readdir },
    })
    const first = h.svc.hosts()
    await vi.advanceTimersByTimeAsync(0) // the native load is now in flight…
    h.svc.invalidate() // …and made stale
    release()
    await first
    expect(h.watchCalls).toHaveLength(0)
  })

  it("settingsChanged reloads only when the ssh block changed", async () => {
    let raw = JSON.stringify({ theme: "gruvbox" })
    const h = harness({ readSettings: () => raw })
    await h.svc.hosts()
    raw = JSON.stringify({ theme: "catppuccin", font: { size: 20 } })
    h.svc.settingsChanged()
    await vi.advanceTimersByTimeAsync(250)
    expect(h.onChange).not.toHaveBeenCalled()
    raw = JSON.stringify({ theme: "catppuccin", ssh: { hidden: ["db"] } })
    h.svc.settingsChanged()
    await vi.advanceTimersByTimeAsync(250)
    expect(h.onChange).toHaveBeenCalledTimes(1)
    expect(shown(await h.svc.hosts()).map((x) => x.hostId)).toEqual(["native:web"])
  })

  it("keeps the last good settings when settings.json doesn't parse (mid-save, a typo)", async () => {
    let raw = JSON.stringify({ ssh: { hidden: ["db"], keepAliveSeconds: 0 } })
    const h = harness({ readSettings: () => raw })
    raw = "{ half-saved"
    h.svc.settingsChanged()
    await vi.advanceTimersByTimeAsync(250)
    expect(h.onChange).not.toHaveBeenCalled()
    expect(shown(await h.svc.hosts()).map((x) => x.hostId)).toEqual(["native:web"])
    expect(await h.svc.spawnPlan(web)).toEqual({ file: SSH, args: ["-t", "--", "web"] })
  })

  it("applies a new keepalive to the next spawn", async () => {
    let raw = "{}"
    const h = harness({ readSettings: () => raw })
    expect((await h.svc.spawnPlan(web)) as { args: string[] }).toMatchObject({
      args: expect.arrayContaining(["ServerAliveInterval=30"]),
    })
    raw = JSON.stringify({ ssh: { keepAliveSeconds: 0 } })
    h.svc.settingsChanged()
    expect(await h.svc.spawnPlan(web)).toEqual({ file: SSH, args: ["-t", "--", "web"] })
  })

  it("flags a host that opted in to shell integration, from the next spawn", async () => {
    let raw = JSON.stringify({ ssh: { keepAliveSeconds: 0 } })
    const h = harness({ readSettings: () => raw })
    expect(await h.svc.spawnPlan(web)).toEqual({ file: SSH, args: ["-t", "--", "web"] })
    raw = JSON.stringify({ ssh: { keepAliveSeconds: 0, integration: ["w*", "!db"] } })
    h.svc.settingsChanged()
    expect(await h.svc.spawnPlan(web)).toEqual({
      file: SSH,
      args: ["-t", "--", "web"], // main adds the bootstrap: the plan only says so
      integration: true,
    })
    expect(await h.svc.spawnPlan({ hostId: "native:db" })).not.toHaveProperty("integration")
  })

  it("asks ssh for the effective config with the same options, and plain if it runs a command", async () => {
    const settings = { ssh: { integration: ["*"] } }
    const probes: string[][] = []
    let config: string | null = "remotecommand tmux new -A -s main\n"
    const h = harness(
      {
        sshEffectiveConfig: async (file, args) => {
          probes.push([file, ...args])
          return config
        },
      },
      { settings },
    )
    const plain = { file: SSH, args: expect.arrayContaining(["-t", "--", "web"]) }
    expect(await h.svc.spawnPlan(web)).toEqual(plain) // the user's RemoteCommand wins
    expect(probes[0]).toEqual([
      SSH,
      ...((await h.svc.spawnPlan(web)) as { args: string[] }).args.map((a) =>
        a === "-t" ? "-G" : a,
      ),
    ])
    expect(probes).toHaveLength(1) // a RemoteCommand "no" is kept
    h.svc.invalidate()
    config = null // ssh -G failed: never guess, and ask again next time
    expect(await h.svc.spawnPlan(web)).not.toHaveProperty("integration")
    expect(await h.svc.spawnPlan(web)).not.toHaveProperty("integration")
    expect(probes).toHaveLength(3)
    h.svc.invalidate()
    config = "remotecommand none\n"
    expect(await h.svc.spawnPlan(web)).toHaveProperty("integration", true)
    const asked = probes.length
    expect(await h.svc.spawnPlan(web)).toHaveProperty("integration", true)
    expect(probes).toHaveLength(asked) // a "yes" is kept until something changes…
    h.svc.invalidate()
    await h.svc.spawnPlan(web)
    expect(probes).toHaveLength(asked + 1) // …like the config
  })

  it("a host marked plain connects plainly until its setting or the config changes", async () => {
    let raw = JSON.stringify({ ssh: { integration: ["web"] } })
    const h = harness({ readSettings: () => raw })
    h.svc.markPlain("native:web")
    expect(await h.svc.spawnPlan(web)).not.toHaveProperty("integration")
    raw = JSON.stringify({ ssh: { integration: [] } })
    h.svc.settingsChanged()
    raw = JSON.stringify({ ssh: { integration: ["web"] } })
    h.svc.settingsChanged() // switched off and on: try again
    expect(await h.svc.spawnPlan(web)).toHaveProperty("integration", true)
    h.svc.markPlain("native:web")
    h.svc.invalidate() // e.g. the ssh config was edited
    expect(await h.svc.spawnPlan(web)).toHaveProperty("integration", true)
  })

  it("integrationMode: all hosts but their exceptions, or none", async () => {
    let raw = JSON.stringify({ ssh: { integrationMode: "all", integration: ["!db"] } })
    const h = harness({ readSettings: () => raw })
    expect(await h.svc.spawnPlan(web)).toHaveProperty("integration", true)
    expect(await h.svc.spawnPlan({ hostId: "native:db" })).not.toHaveProperty("integration")
    raw = JSON.stringify({ ssh: { integrationMode: "off", integration: ["web"] } })
    h.svc.settingsChanged()
    expect(await h.svc.spawnPlan(web)).not.toHaveProperty("integration")
  })

  it("toggling integration doesn't reload the host list", async () => {
    let raw = "{}"
    const h = harness({ readSettings: () => raw })
    await h.svc.hosts()
    raw = JSON.stringify({ ssh: { integration: ["web"] } })
    h.svc.settingsChanged()
    await vi.advanceTimersByTimeAsync(250)
    expect(h.onChange).not.toHaveBeenCalled()
    expect(await h.svc.spawnPlan(web)).toHaveProperty("integration", true)
  })

  it("settingsChanged with nothing changed is a no-op", async () => {
    const h = harness()
    h.svc.settingsChanged()
    await vi.advanceTimersByTimeAsync(250)
    expect(h.onChange).not.toHaveBeenCalled()
  })

  it("invalidates even when a spawn already read the new settings before the watcher fired", async () => {
    let raw = "{}"
    const h = harness({ readSettings: () => raw })
    await h.svc.hosts()
    raw = JSON.stringify({ ssh: { hidden: ["web"] } })
    await h.svc.spawnPlan(web)
    h.svc.settingsChanged()
    await vi.advanceTimersByTimeAsync(250)
    expect(h.onChange).toHaveBeenCalledTimes(1)
    expect(shown(await h.svc.hosts()).map((x) => x.hostId)).toEqual(["native:db"])
  })

  it("keeps ~/.ssh/config watched while a distro reload finishes first", async () => {
    let release!: () => void
    const nativeGate = new Promise<void>((r) => (release = r))
    let gateNative = false
    const base = memFs({ ["C:\\Users\\me\\.ssh\\config"]: "Host n\n" }, path.win32)
    const h = harness({
      platform: "win32",
      home: "C:\\Users\\me",
      fs: {
        readFile: async (p) => (gateNative && (await nativeGate), base.readFile(p)),
        readdir: base.readdir,
      },
      wslRunningDistros: async () => ["Ubuntu"],
      wslHome: async () => "/home/me",
      wslFs: () => memFs({ "/home/me/.ssh/config": "Host w\n" }),
    })
    await h.svc.hosts()
    gateNative = true
    h.svc.invalidate()
    const listing = h.svc.hosts()
    await vi.advanceTimersByTimeAsync(0)
    // The distro reloaded; native is still loading — its paths must still be watched.
    expect(h.watchCalls.at(-1)!.paths.some((p) => p.endsWith(".ssh\\config"))).toBe(true)
    release()
    await listing
  })

  it("a load finishing after dispose never installs a watcher", async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const base = memFs({ [`${HOME}/.ssh/config`]: "Host a\n" })
    const h = harness({
      fs: { readFile: async (p) => (await gate, base.readFile(p)), readdir: base.readdir },
    })
    const loading = h.svc.hosts()
    h.svc.dispose()
    release()
    await loading
    expect(h.watchCalls).toHaveLength(0)
  })

  it("dispose closes the watcher and any pending notification", async () => {
    const h = harness()
    await h.svc.hosts()
    h.svc.invalidate()
    h.svc.dispose()
    await vi.advanceTimersByTimeAsync(250)
    expect(h.watchCalls[0]!.closed).toBe(true)
    expect(h.onChange).not.toHaveBeenCalled()
  })
})

describe("SshService.spawnPlan", () => {
  it("runs plain ssh with the keepalive for a config host", async () => {
    expect(await harness().svc.spawnPlan(web)).toEqual({
      file: SSH,
      args: [...KA, "-t", "--", "web"],
    })
  })

  it("takes the host from main's own list, ignoring what the renderer sent", async () => {
    const sent = {
      hostId: "native:web",
      label: "x",
      target: "-oProxyCommand=evil",
      env: "wsl:Other",
    }
    expect(await harness().svc.spawnPlan(sent)).toEqual({
      file: SSH,
      args: [...KA, "-t", "--", "web"],
    })
  })

  it("refuses a host that's not in the config, and garbage", async () => {
    const h = harness()
    for (const bad of [{ hostId: "native:gone", target: "gone", env: "native" }, null, "x", {}]) {
      expect(await h.svc.spawnPlan(bad)).toEqual({ error: expect.stringContaining("ssh config") })
    }
  })

  it("keeps a hidden host spawnable (a restored pane)", async () => {
    const h = harness({}, { settings: { ssh: { hidden: ["web"] } } })
    expect(shown(await h.svc.hosts())).toHaveLength(1)
    expect(await h.svc.spawnPlan(web)).toHaveProperty("file", SSH)
  })

  it("adds no keepalive when it's turned off", async () => {
    const h = harness({}, { settings: { ssh: { keepAliveSeconds: 0 } } })
    expect(await h.svc.spawnPlan(web)).toEqual({ file: SSH, args: ["-t", "--", "web"] })
  })

  it("says so plainly for a WSL host off Windows, and a host saved by a newer build", async () => {
    const h = harness()
    expect(await h.svc.spawnPlan({ hostId: "wsl:Ubuntu:box" })).toEqual({
      error: "WSL hosts can only be opened on Windows",
    })
    expect(await h.svc.spawnPlan({ hostId: "unavailable" })).toEqual({
      error: expect.stringContaining("newer minmux"),
    })
  })

  it("errors when ssh isn't installed", async () => {
    const h = harness({ sshPath: async () => null })
    expect(await h.svc.spawnPlan(web)).toEqual({ error: expect.stringContaining("ssh") })
  })

  it("uses Windows ssh.exe the same way", async () => {
    const exe = "C:\\Windows\\System32\\OpenSSH\\ssh.exe"
    const h = harness({
      platform: "win32",
      home: "C:\\Users\\me",
      fs: memFs({ "C:\\Users\\me\\.ssh\\config": "Host w\n" }, path.win32),
      sshPath: async () => exe,
    })
    expect(await h.svc.spawnPlan({ hostId: "native:w" })).toEqual({
      file: exe,
      args: [...KA, "-t", "--", "w"],
    })
  })

  it("runs a WSL host through the distro's own ssh on Windows, and refuses it elsewhere", async () => {
    const wsl = {
      wslHome: async () => "/home/me",
      wslFs: () => memFs({ "/home/me/.ssh/config": "Host box\n" }),
    }
    const win = harness({
      platform: "win32",
      home: "C:\\Users\\me",
      fs: memFs({}, path.win32),
      ...wsl,
    })
    expect(await win.svc.spawnPlan({ hostId: "wsl:Ubuntu:box" })).toEqual({
      file: "wsl.exe",
      args: ["-d", "Ubuntu", "--cd", "~", "-e", "ssh", ...KA, "-t", "--", "box"],
    })
    const mac = harness(wsl)
    expect(await mac.svc.spawnPlan({ hostId: "wsl:Ubuntu:box" })).toHaveProperty("error")
  })

  it("spawns a native host without waiting for WSL distros to boot", async () => {
    let release!: () => void
    const slow = new Promise<void>((r) => (release = r))
    const exe = "C:\\ssh.exe"
    const h = harness({
      platform: "win32",
      home: "C:\\Users\\me",
      fs: memFs({ "C:\\Users\\me\\.ssh\\config": "Host web\n" }, path.win32),
      sshPath: async () => exe,
      wslRunningDistros: async () => ["Ubuntu"],
      wslHome: async () => (await slow, "/home/me"),
      wslFs: () => memFs({ "/home/me/.ssh/config": "Host box\n" }),
    })
    expect(await h.svc.spawnPlan(web)).toEqual({ file: exe, args: [...KA, "-t", "--", "web"] })
    const wslPlan = h.svc.spawnPlan({ hostId: "wsl:Ubuntu:box" })
    release()
    expect(await wslPlan).toHaveProperty("file", "wsl.exe")
  })

  it("works the plan out again when the config changes meanwhile (a host just removed)", async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    let config = "Host web\n"
    let calls = 0
    const h = harness({
      fs: { readFile: async () => config, readdir: async () => null },
      sshPath: async () => (calls++ === 0 && (await gate), SSH),
    })
    const planning = h.svc.spawnPlan(web)
    await new Promise((r) => setTimeout(r, 0))
    config = "Host other\n" // the user deletes `web` while the first plan is in flight
    h.svc.invalidate()
    release()
    expect(await planning).toEqual({ error: expect.stringContaining("ssh config") })
  })
})

describe("SshService — settings main doesn't use", () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it("a pin or a colour change doesn't reload the configs", async () => {
    let raw = JSON.stringify({})
    const h = harness({ readSettings: () => raw })
    await h.svc.hosts()
    raw = JSON.stringify({ ssh: { pinned: ["native:web"], colors: { web: "red" } } })
    h.svc.settingsChanged()
    await vi.advanceTimersByTimeAsync(250)
    expect(h.onChange).not.toHaveBeenCalled()
  })

  it("git hosts are hidden by default, even with a saved empty `hidden`", async () => {
    const h = harness(
      {},
      { config: "Host web\nHost github.com\n", settings: { ssh: { hidden: [] } } },
    )
    const hosts = await h.svc.hosts()
    expect(hosts.find((x) => x.hostId === "native:github.com")?.hidden).toBe(true)
    expect(hosts.find((x) => x.hostId === "native:web")?.hidden).toBeUndefined()
  })
})
