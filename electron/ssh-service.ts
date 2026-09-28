// Main-process SSH remotes service (docs/design/SSH_IMPLEMENTATION_PLAN.md step 3): the
// host list (~/.ssh/config natively and in WSL distros), watching those files, and turning a
// renderer's RemoteRef into the exact ssh command. Everything touching the OS is injected
// (SshDeps) so it's unit-tested; all of it is async and off the PTY → renderer path.

import path from "node:path"
import type { SshHost } from "../src/types"
import {
  effectiveHidden,
  mergeSshSettings,
  parseSshEnv,
  type SshSettings,
} from "../src/lib/ssh-validate"
import { SSH_ERRORS } from "../src/lib/ssh-errors"
import {
  globMatchesPath,
  loadSshConfig,
  type LoadResult,
  type MiniFs,
  type SshConfigHost,
} from "./ssh-config"
import { integrationOn } from "../src/lib/ssh-integration"
import { hasRemoteCommand } from "./remote-bootstrap"
import { buildSshSpawn, mergeHosts, trustedRemote } from "./ssh-hosts"

/** Everything the service needs from the OS. */
export interface SshDeps {
  platform: NodeJS.Platform
  home: string
  readSettings: () => string // raw settings.json ("" if missing)
  fs: MiniFs // native config access
  wslRunningDistros: () => Promise<string[]> // only running ones: listing never boots a VM
  wslHome: (distro: string, timeoutMs: number) => Promise<string | null> // null = no answer
  wslFs: (distro: string) => MiniFs // Linux paths → the distro's UNC share
  wslWatchPaths: (distro: string, linuxPath: string) => string[] // host paths to watch
  sshPath: () => Promise<string | null> // the native ssh's full path (null = not installed)
  // `ssh -G …`'s output (the effective config), null on failure — asked only for opted-in hosts
  sshEffectiveConfig: (file: string, args: string[]) => Promise<string | null>
  createWatcher: (onChange: (path: string) => void) => {
    set: (paths: string[]) => void
    close: () => void
  }
  onChange: () => void // the host list changed (debounced)
}

/** `integration`: the host opted in to smterm's shell integration (main adds the bootstrap). */
export type SpawnPlan = { file: string; args: string[]; integration?: boolean } | { error: string }

const RUNNING_DISTROS_TTL_MS = 5000 // `wsl -l --running` is a process spawn: not per call
const LIST_WSL_WAIT_MS = 5000 // the sidebar stops waiting on a slow distro after this…
const WSL_TIMEOUT_MS = 20_000 // …though its load (shared with spawns) may take this long
const WSL_TTL_MS = 30_000 // watching \\wsl$ shares is unreliable: re-read a distro's config
const CHANGE_DEBOUNCE_MS = 200

/** `p`, or null if it takes longer than `ms` (the timer is cleared either way). */
function orNullAfter<T>(p: Promise<T | null>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<null>((r) => (timer = setTimeout(() => r(null), ms)))
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer))
}

type DistroHosts = { hosts: SshConfigHost[]; watch: string[]; globs: string[] }

/** The part of the ssh settings the host list depends on: a pin, a colour or the integration
 *  list needs no reload (spawns read the current block). */
const mainKey = (s: SshSettings) =>
  JSON.stringify([effectiveHidden(s).map((a) => a.toLowerCase()), s.keepAliveSeconds])

export class SshService {
  private native: Promise<LoadResult> | null = null
  private distros = new Map<string, { at: number; p: Promise<DistroHosts | null> }>()
  private display: Promise<SshHost[]> | null = null
  private displayDistros = "" // the running distros `display` was built for
  private displayAt = 0
  private watched = {
    native: { paths: [] as string[], globs: [] as string[] },
    wsl: new Map<string, { paths: string[]; globs: string[] }>(),
  }
  private watcher: ReturnType<SshDeps["createWatcher"]> | null = null
  private debounce: ReturnType<typeof setTimeout> | null = null
  private generation = 0 // bumps on every invalidation, so a stale load can't install itself
  private disposed = false
  private current: SshSettings // the ssh block as of the last change (read once, not per spawn)
  private settingsKey: string
  private running: { at: number; list: Promise<string[]> } | null = null
  private probes = new Map<string, Promise<boolean>>() // `ssh -G` verdicts, per generation
  private plain = new Set<string>() // hostIds whose bootstrap couldn't start (see markPlain)

  constructor(private readonly deps: SshDeps) {
    this.current = this.readSettings() ?? mergeSshSettings({})
    this.settingsKey = mainKey(this.current)
  }

  /** The sidebar list (hidden hosts filtered; WSL hosts of running distros only). */
  async hosts(): Promise<SshHost[]> {
    // Which distros run is cheap to ask and changes on its own (no file to watch): a list
    // built for a different set is stale — and WSL configs are re-read after WSL_TTL_MS.
    const running = await this.runningDistros()
    const key = running.join("\0")
    const fresh = !running.length || Date.now() - this.displayAt < WSL_TTL_MS
    if (this.display && key === this.displayDistros && fresh) return this.display
    const built = this.buildDisplay(running)
    const p = built.then((r) => r.hosts)
    this.display = p
    this.displayDistros = key
    this.displayAt = Date.now()
    // A failed or partial list (a distro that didn't answer) isn't kept: the next call retries.
    const forget = () => {
      if (this.display === p) this.display = null
    }
    built.then((r) => r.partial && forget(), forget)
    return p
  }

  /** A config or settings change: drop caches and tell the renderer (debounced). */
  invalidate(): void {
    this.generation++
    this.native = null
    this.distros.clear()
    this.display = null
    this.running = null
    this.probes.clear()
    this.plain.clear() // the config changed: a fixed host gets integration again
    // Distro paths are re-learned as distros reload; the native ones stay watched until its
    // reload replaces them (a distro load finishing first must not unwatch ~/.ssh/config).
    this.watched.wsl = new Map()
    if (this.debounce) clearTimeout(this.debounce)
    this.debounce = setTimeout(() => {
      this.debounce = null
      this.deps.onChange()
    }, CHANGE_DEBOUNCE_MS)
  }

  /** settings.json changed: reload only if its `ssh` block did (not on a theme toggle). A
   *  file that doesn't parse (mid-save, a typo) keeps the last good block. */
  settingsChanged(): void {
    const next = this.readSettings()
    if (!next) return
    const key = mainKey(next)
    if (JSON.stringify(next.integration) !== JSON.stringify(this.current.integration)) {
      this.plain.clear() // switched off and on again: try again
    }
    this.current = next
    if (key === this.settingsKey) return
    this.settingsKey = key
    this.invalidate()
  }

  dispose(): void {
    this.disposed = true
    this.generation++ // a load still in flight must not install a watcher after this
    this.watcher?.close()
    this.watcher = null
    if (this.debounce) clearTimeout(this.debounce)
  }

  /** The command for a renderer's RemoteRef, from main's own host list (worked out again if
   *  the config changes meanwhile). */
  async spawnPlan(ref: unknown): Promise<SpawnPlan> {
    for (let attempt = 0; ; attempt++) {
      const gen = this.generation
      const plan = await this.planOnce(ref)
      if (gen === this.generation || attempt >= 2) return plan
    }
  }

  private async planOnce(ref: unknown): Promise<SpawnPlan> {
    const hostId = ref && typeof ref === "object" ? (ref as { hostId?: unknown }).hostId : undefined
    if (hostId === "unavailable") {
      return { error: SSH_ERRORS.newerBuild }
    }
    if (typeof hostId === "string" && hostId.startsWith("wsl:") && this.deps.platform !== "win32") {
      return { error: SSH_ERRORS.wslOffWindows }
    }
    const trust = await this.trustFor(ref)
    const remote = trustedRemote(ref, trust.hosts)
    if (!remote) {
      return {
        error: trust.distroDown ? SSH_ERRORS.wslDown(trust.distroDown) : SSH_ERRORS.hostGone,
      }
    }
    const { platform } = this.deps
    const keepAliveSeconds = this.current.keepAliveSeconds
    const integration =
      integrationOn(remote.label, this.current.integration) && !this.plain.has(remote.hostId)
    if (parseSshEnv(remote.env)?.kind === "wsl") {
      const plan = buildSshSpawn(remote, { platform, sshPath: "ssh", keepAliveSeconds })
      return plan ? this.withIntegration(plan, integration) : { error: SSH_ERRORS.wslOffWindows }
    }
    const sshPath = await this.deps.sshPath()
    if (!sshPath) return { error: SSH_ERRORS.noSsh }
    const plan = buildSshSpawn(remote, { platform, sshPath, keepAliveSeconds })
    return plan ? this.withIntegration(plan, integration) : { error: SSH_ERRORS.cantBuild }
  }

  // An opted-in host gets the bootstrap unless its config runs a command of its own
  // (RemoteCommand: ssh refuses both, and the user's wins). Asked of ssh itself (`-G`, the
  // same options), so Match blocks and Includes count; any doubt → a plain connection.
  private async withIntegration(
    plan: { file: string; args: string[] },
    integration: boolean,
  ): Promise<SpawnPlan> {
    if (!integration) return plan
    const tty = plan.args.lastIndexOf("--") - 1 // buildSshSpawn ends with `-t -- <target>`
    if (plan.args[tty] !== "-t") return plan
    const probe = plan.args.map((a, i) => (i === tty ? "-G" : a))
    // Asked once per host until the config or settings change (a failure is asked again).
    const key = JSON.stringify([plan.file, probe])
    let ok = this.probes.get(key)
    if (!ok) {
      // null = ssh -G failed (asked again next time); a RemoteCommand is a kept "no".
      const verdict = this.deps
        .sshEffectiveConfig(plan.file, probe)
        .catch(() => null)
        .then((c) => (c === null ? null : !hasRemoteCommand(c)))
      ok = verdict.then((v) => v === true)
      this.probes.set(key, ok)
      const p = ok
      void verdict.then((v) => v === null && this.probes.get(key) === p && this.probes.delete(key))
    }
    return (await ok) ? { ...plan, integration } : plan
  }

  /** The host couldn't run the bootstrap (no sh): connect it plainly until the ssh config or
   *  its integration setting changes. */
  markPlain(hostId: string): void {
    this.plain.add(hostId)
  }

  // null = settings.json doesn't parse right now.
  private readSettings(): SshSettings | null {
    try {
      const raw = JSON.parse(this.deps.readSettings() || "{}") as { ssh?: unknown }
      return mergeSshSettings(raw?.ssh)
    } catch {
      return null
    }
  }

  private async buildDisplay(running: string[]): Promise<{ hosts: SshHost[]; partial: boolean }> {
    const native = await this.loadNative()
    // One shared load per distro (with the full budget, for a pane that needs it); the list
    // just stops waiting after LIST_WSL_WAIT_MS — a list missing it is partial, not cached.
    const loaded = await Promise.all(
      running.map((d) => orNullAfter(this.loadDistro(d), LIST_WSL_WAIT_MS)),
    )
    const wsl: [string, SshConfigHost[]][] = []
    running.forEach((d, i) => {
      const r = loaded[i]
      if (r) wsl.push([d, r.hosts])
    })
    const input = {
      native: native.hosts,
      wsl,
      settings: { hidden: effectiveHidden(this.current) },
      platform: this.deps.platform,
    }
    return {
      hosts: mergeHosts(input, { markHidden: true }),
      partial: loaded.some((r) => r === null),
    }
  }

  // The hosts a ref may resolve against (hidden ones included, so restored panes keep
  // working). A WSL host boots just its own distro; native hosts never wait on WSL.
  private async trustFor(ref: unknown): Promise<{ hosts: SshHost[]; distroDown?: string }> {
    const hostId = ref && typeof ref === "object" ? (ref as { hostId?: unknown }).hostId : undefined
    const distro = typeof hostId === "string" ? /^wsl:([^:]+):/.exec(hostId)?.[1] : undefined
    const native = await this.loadNative()
    const wsl: [string, SshConfigHost[]][] = []
    let distroDown: string | undefined
    if (distro && this.deps.platform === "win32" && parseSshEnv(`wsl:${distro}`)) {
      const r = await this.loadDistro(distro)
      if (r) wsl.push([distro, r.hosts])
      else distroDown = distro
    }
    const input = {
      native: native.hosts,
      wsl,
      settings: { hidden: effectiveHidden(this.current) },
      platform: this.deps.platform,
    }
    return { hosts: mergeHosts(input, { all: true }), distroDown }
  }

  // ~/.ssh/config, read once per generation and shared by the list and every spawn.
  private loadNative(): Promise<LoadResult> {
    if (this.native) return this.native
    const gen = this.generation
    const { home, platform } = this.deps
    const p = platform === "win32" ? path.win32 : path.posix
    const load = loadSshConfig({
      file: p.join(home, ".ssh", "config"),
      home,
      fs: this.deps.fs,
      path: p,
    })
    this.native = load
    load.then(
      (r) => {
        if (gen !== this.generation) return
        this.watched.native = { paths: r.watch, globs: r.globs }
        this.rewatch()
      },
      () => {
        if (this.native === load) this.native = null // failures aren't kept: retry next time
      },
    )
    return load
  }

  private runningDistros(): Promise<string[]> {
    if (this.deps.platform !== "win32") return Promise.resolve([])
    const now = Date.now()
    if (this.running && now - this.running.at < RUNNING_DISTROS_TTL_MS) return this.running.list
    // Docker Desktop's internal distros hold no user shell (or ssh config).
    const list = this.deps
      .wslRunningDistros()
      .then((ds) => ds.filter((d) => !/^docker-desktop/i.test(d)))
      .catch(() => [])
    this.running = { at: now, list }
    return list
  }

  // One distro's ssh config; a distro that doesn't answer (cold VM, timeout) isn't cached.
  private loadDistro(distro: string): Promise<DistroHosts | null> {
    const cached = this.distros.get(distro)
    if (cached && Date.now() - cached.at < WSL_TTL_MS) return cached.p
    const gen = this.generation
    const p = (async (): Promise<DistroHosts | null> => {
      try {
        const dh = await this.deps.wslHome(distro, WSL_TIMEOUT_MS)
        if (!dh) return null
        const r = await loadSshConfig({
          file: path.posix.join(dh, ".ssh", "config"),
          home: dh,
          fs: this.deps.wslFs(distro),
          path: path.posix,
        })
        const toHost = (w: string) => this.deps.wslWatchPaths(distro, w)
        return { hosts: r.hosts, watch: r.watch.flatMap(toHost), globs: r.globs.flatMap(toHost) }
      } catch {
        return null
      }
    })()
    this.distros.set(distro, { at: Date.now(), p })
    void p.then((r) => {
      if (gen !== this.generation) return
      if (!r) {
        if (this.distros.get(distro)?.p === p) this.distros.delete(distro)
        return
      }
      this.watched.wsl.set(distro, { paths: r.watch, globs: r.globs })
      this.rewatch()
    })
    return p
  }

  private rewatch(): void {
    if (this.disposed) return
    this.watcher ??= this.deps.createWatcher((p) => this.changed(p))
    const all = [this.watched.native, ...this.watched.wsl.values()]
    this.watcher.set(all.flatMap((w) => w.paths))
  }

  // A watched path changed. Watched dirs also see unrelated files (ssh writes known_hosts
  // into ~/.ssh): only the files we read, the dirs themselves, or Include-glob matches count.
  private changed(file: string): void {
    const all = [this.watched.native, ...this.watched.wsl.values()]
    const p = this.deps.platform === "win32" ? path.win32 : path.posix
    const norm = (x: string) => p.normalize(x)
    const f = norm(file)
    const relevant =
      all.some((w) => w.paths.some((x) => norm(x) === f)) ||
      all.some((w) => w.globs.some((g) => globMatchesPath(g, f, p)))
    if (relevant) this.invalidate()
  }
}
