import { execFileSync, spawnSync } from "node:child_process"
import { describe, expect, it } from "vitest"
import type { RemoteRef, SshHost } from "../src/types"
import {
  buildSshSpawn,
  hostDetail,
  keepAliveFlags,
  mergeHosts,
  trustedRemote,
  type MergeInput,
  type SpawnContext,
} from "./ssh-hosts"

// Windows by default, so WSL hosts are listed; tests override platform where it matters.
const merge = (
  i: Partial<Omit<MergeInput, "platform">> & { platform?: NodeJS.Platform },
  o?: { all?: boolean; markHidden?: boolean },
) => mergeHosts({ native: [], wsl: [], settings: { hidden: [] }, platform: "win32", ...i }, o)

describe("hostDetail", () => {
  it("formats user@hostname:port from the parts that are set", () => {
    expect(hostDetail({ alias: "a", hostName: "h", user: "u", port: "2222" })).toBe("u@h:2222")
    expect(hostDetail({ alias: "a", hostName: "h" })).toBe("h")
    expect(hostDetail({ alias: "a", hostName: "h", port: "2222" })).toBe("h:2222")
  })

  it("hides the default port", () => {
    expect(hostDetail({ alias: "a", hostName: "h", port: "22" })).toBe("h")
  })

  it("uses the alias as host when only User or a port is set, and nothing when neither is", () => {
    expect(hostDetail({ alias: "box", user: "u" })).toBe("u@box")
    expect(hostDetail({ alias: "box", port: "2200" })).toBe("box:2200")
    expect(hostDetail({ alias: "box" })).toBeUndefined()
    expect(hostDetail({ alias: "box", port: "22" })).toBeUndefined()
  })
})

describe("mergeHosts", () => {
  it("builds config hosts with stable ids, env and detail", () => {
    expect(
      merge({ native: [{ alias: "web", hostName: "10.0.0.1", user: "me" }, { alias: "db" }] }),
    ).toEqual([
      { hostId: "native:web", label: "web", target: "web", env: "native", detail: "me@10.0.0.1" },
      { hostId: "native:db", label: "db", target: "db", env: "native" },
    ])
  })

  it("keeps the same alias separately per environment", () => {
    const hosts = merge({
      native: [{ alias: "gpu" }],
      wsl: [
        ["Ubuntu", [{ alias: "gpu" }]],
        ["Debian", [{ alias: "gpu" }]],
      ],
    })
    expect(hosts.map((h) => [h.hostId, h.env])).toEqual([
      ["native:gpu", "native"],
      ["wsl:Ubuntu:gpu", "wsl:Ubuntu"],
      ["wsl:Debian:gpu", "wsl:Debian"],
    ])
  })

  it("filters hidden aliases case-insensitively, in every environment", () => {
    const hosts = merge({
      native: [{ alias: "github.com" }, { alias: "keep" }],
      wsl: [["Ubuntu", [{ alias: "GitHub.com" }]]],
      settings: { hidden: ["GITHUB.COM"] },
    })
    expect(hosts.map((h) => h.hostId)).toEqual(["native:keep"])
  })

  it("keeps hidden hosts with `all` (main's trust list, so restored panes still spawn)", () => {
    const input = { native: [{ alias: "web" }], settings: { hidden: ["web"] } }
    expect(merge(input)).toEqual([])
    expect(merge(input, { all: true }).map((h) => h.hostId)).toEqual(["native:web"])
  })

  it("skips aliases that aren't safe ssh destinations", () => {
    const hosts = merge({
      native: [
        { alias: "my box" },
        { alias: "-oProxyCommand=x" },
        { alias: "a;b" },
        { alias: "ok" },
      ],
    })
    expect(hosts.map((h) => h.hostId)).toEqual(["native:ok"])
  })

  it("skips a WSL distro whose name isn't a valid env, and every WSL host off Windows", () => {
    expect(merge({ wsl: [["bad name", [{ alias: "a" }]]] })).toEqual([])
    const input = {
      native: [{ alias: "web" }],
      wsl: [["Ubuntu", [{ alias: "w" }]]] as MergeInput["wsl"],
    }
    expect(merge({ ...input, platform: "darwin" }).map((h) => h.hostId)).toEqual(["native:web"])
    expect(merge({ ...input, platform: "linux" }).map((h) => h.hostId)).toEqual(["native:web"])
    expect(merge(input).map((h) => h.hostId)).toEqual(["native:web", "wsl:Ubuntu:w"])
  })

  it("never returns duplicate ids", () => {
    expect(merge({ native: [{ alias: "a" }, { alias: "a" }] }).map((h) => h.hostId)).toEqual([
      "native:a",
    ])
  })
})

describe("keepAliveFlags", () => {
  it("adds ssh's own keepalive, ending a dead connection after 4 missed replies", () => {
    expect(keepAliveFlags(30)).toEqual([
      "-o",
      "ServerAliveInterval=30",
      "-o",
      "ServerAliveCountMax=4",
    ])
  })

  it("adds nothing for 0 (the user's config decides)", () => {
    expect(keepAliveFlags(0)).toEqual([])
  })
})

describe("buildSshSpawn", () => {
  const remote: RemoteRef = { hostId: "native:web", label: "web", target: "web", env: "native" }
  const mac: SpawnContext = { platform: "darwin", sshPath: "/usr/bin/ssh", keepAliveSeconds: 30 }
  const win: SpawnContext = {
    platform: "win32",
    sshPath: "C:\\Windows\\System32\\OpenSSH\\ssh.exe",
    keepAliveSeconds: 30,
  }

  it("runs plain ssh with the keepalive, then -t -- alias", () => {
    expect(buildSshSpawn(remote, mac)).toEqual({
      file: "/usr/bin/ssh",
      args: [...keepAliveFlags(30), "-t", "--", "web"],
    })
    expect(buildSshSpawn(remote, { ...mac, keepAliveSeconds: 0 })!.args).toEqual([
      "-t",
      "--",
      "web",
    ])
  })

  it("uses Windows ssh.exe the same way", () => {
    expect(buildSshSpawn(remote, win)).toEqual({
      file: "C:\\Windows\\System32\\OpenSSH\\ssh.exe",
      args: [...keepAliveFlags(30), "-t", "--", "web"],
    })
  })

  it("keeps a hostile-looking target after `--` so ssh can't read it as an option", () => {
    const args = buildSshSpawn({ ...remote, target: "-oProxyCommand=evil" }, mac)!.args
    expect(args.indexOf("--")).toBeLessThan(args.indexOf("-oProxyCommand=evil"))
    expect(args[args.length - 1]).toBe("-oProxyCommand=evil")
  })

  it("runs a WSL host through the distro's own ssh, never our shell integration", () => {
    const r: RemoteRef = { ...remote, hostId: "wsl:Ubuntu:web", env: "wsl:Ubuntu" }
    const plan = buildSshSpawn(r, win)
    expect(plan).toEqual({
      file: "wsl.exe",
      args: ["-d", "Ubuntu", "--cd", "~", "-e", "ssh", ...keepAliveFlags(30), "-t", "--", "web"],
    })
    expect(plan!.args).not.toContain("--rcfile")
  })

  it("returns null for a WSL host off Windows, or a malformed env", () => {
    expect(buildSshSpawn({ ...remote, env: "wsl:Ubuntu" }, mac)).toBeNull()
    expect(buildSshSpawn({ ...remote, env: "bogus" as RemoteRef["env"] }, mac)).toBeNull()
  })
})

const sshBin = spawnSync("ssh", ["-V"]).status === 0

// The real OpenSSH must accept the keepalive flags (ssh -G prints its resolved config).
describe.runIf(sshBin && process.platform !== "win32")("keepAliveFlags with real ssh -G", () => {
  it("sets ServerAliveInterval and ServerAliveCountMax", () => {
    const out = execFileSync(
      "ssh",
      ["-G", "-F", "/dev/null", ...keepAliveFlags(30), "--", "example.invalid"],
      { encoding: "utf8" },
    )
    expect(out).toMatch(/^serveraliveinterval 30$/m)
    expect(out).toMatch(/^serveralivecountmax 4$/m)
  })
})

describe("trustedRemote", () => {
  const listed: SshHost[] = [{ hostId: "native:web", label: "web", target: "web", env: "native" }]

  it("uses main's own copy of a listed host, ignoring what the renderer sent", () => {
    const sent = { hostId: "native:web", label: "x", target: "evil", env: "wsl:Other", extra: 1 }
    expect(trustedRemote(sent, listed)).toEqual({
      hostId: "native:web",
      label: "web",
      target: "web",
      env: "native",
    })
  })

  it("refuses a host that's no longer listed (a bare alias could reach another machine)", () => {
    expect(
      trustedRemote({ hostId: "native:gone", target: "gone", env: "native" }, listed),
    ).toBeNull()
  })

  it("rejects non-objects and a missing or non-string hostId", () => {
    for (const bad of [null, undefined, "native:web", 3, {}, { hostId: 1 }]) {
      expect(trustedRemote(bad, listed)).toBeNull()
    }
  })
})

describe("mergeHosts — markHidden", () => {
  it("lists hidden hosts too, flagged, instead of dropping them", () => {
    const hosts = merge(
      { native: [{ alias: "web" }, { alias: "github.com" }], settings: { hidden: ["GitHub.com"] } },
      { markHidden: true },
    )
    expect(hosts.map((h) => [h.hostId, h.hidden ?? false])).toEqual([
      ["native:web", false],
      ["native:github.com", true],
    ])
  })
})

describe("buildSshSpawn — a remote folder", () => {
  const remote: RemoteRef = { hostId: "native:web", label: "web", target: "web", env: "native" }
  const mac: SpawnContext = { platform: "darwin", sshPath: "/usr/bin/ssh", keepAliveSeconds: 0 }

  it("appends the fixed cd script after the destination (the folder is its argument)", () => {
    const args = buildSshSpawn(remote, mac, "~/proj")!.args
    expect(args.slice(0, 3)).toEqual(["-t", "--", "web"])
    expect(args).toHaveLength(4)
    expect(args[3]).toMatch(/^exec sh -c '.*' smterm '~\/proj'$/)
  })

  it("adds nothing without a folder", () => {
    expect(buildSshSpawn(remote, mac)!.args).toEqual(["-t", "--", "web"])
  })

  it("WSL: the command goes after the distro's ssh destination too", () => {
    const win: SpawnContext = { platform: "win32", sshPath: "ssh.exe", keepAliveSeconds: 0 }
    const r: RemoteRef = { ...remote, hostId: "wsl:U:web", env: "wsl:U" }
    const args = buildSshSpawn(r, win, "/srv")!.args
    expect(args[args.length - 2]).toBe("web")
    expect(args[args.length - 1]).toContain("smterm '/srv'")
  })
})

describe("mergeHosts — RemoteCommand", () => {
  it("flags a host whose config runs a RemoteCommand", () => {
    const hosts = merge({ native: [{ alias: "t", remoteCommand: "tmux" }, { alias: "p" }] })
    expect(hosts.map((h) => [h.hostId, h.remoteCommand ?? false])).toEqual([
      ["native:t", true],
      ["native:p", false],
    ])
  })
})
