import { describe, it, expect, afterEach } from "vitest"
import os from "node:os"
import path from "node:path"
import {
  parseWslDistros,
  parseDefaultDistro,
  buildInjection,
  setIntegrationDirName,
  isWslShell,
  wslCdArgs,
  parseWslDistroArg,
  parseLoginShell,
  wslInjection,
  ZSH_ZSHRC,
  BASH_RC,
  BASH_HOOKS,
  ZSH_HOOKS,
} from "./shell-integration"

describe("parseWslDistros", () => {
  it("splits distro names and trims blank lines", () => {
    expect(parseWslDistros("Ubuntu\r\nDebian\r\n")).toEqual(["Ubuntu", "Debian"])
    expect(parseWslDistros("\r\n   \r\n")).toEqual([])
  })

  it("strips NUL bytes (UTF-16 decode artifacts)", () => {
    expect(parseWslDistros("U\0b\0untu\n")).toEqual(["Ubuntu"])
  })
})

describe("parseDefaultDistro", () => {
  it("returns the *-marked distro from `wsl -l -v`", () => {
    const out =
      "  NAME            STATE           VERSION\r\n" +
      "* Ubuntu          Running         2\r\n" +
      "  Debian          Stopped         2\r\n"
    expect(parseDefaultDistro(out)).toBe("Ubuntu")
  })
  it("handles the * not on the first data row", () => {
    expect(parseDefaultDistro("  NAME\n  Ubuntu  Running  2\n* Debian  Running  2\n")).toBe(
      "Debian",
    )
  })
  it("tolerates NUL bytes and returns undefined when nothing is marked", () => {
    expect(parseDefaultDistro("*\0 \0Ubuntu\0\n")).toBe("Ubuntu")
    expect(parseDefaultDistro("  Ubuntu  Running  2\n")).toBeUndefined()
  })
})

describe("isWslShell", () => {
  it("matches wsl.exe (any path, case-insensitive)", () => {
    expect(isWslShell("wsl.exe")).toBe(true)
    expect(isWslShell("C:\\Windows\\System32\\wsl.exe")).toBe(true)
    expect(isWslShell("WSL.EXE")).toBe(true)
  })
  it("does not match other shells", () => {
    expect(isWslShell("powershell.exe")).toBe(false)
    expect(isWslShell("/bin/zsh")).toBe(false)
    expect(isWslShell("mywsl.exe.sh")).toBe(false)
  })
})

describe("wslCdArgs", () => {
  it("starts in the Linux home when there's no tracked path", () => {
    expect(wslCdArgs(undefined)).toEqual(["--cd", "~"])
  })
  it("ignores a Windows cwd (would translate to /mnt/c/...) and uses ~", () => {
    expect(wslCdArgs("C:\\Users\\me\\proj")).toEqual(["--cd", "~"])
  })
  it("passes through a tracked Linux path", () => {
    expect(wslCdArgs("/home/me/proj")).toEqual(["--cd", "/home/me/proj"])
  })
})

describe("parseWslDistroArg", () => {
  it("reads the distro from -d / --distribution", () => {
    expect(parseWslDistroArg(["-d", "Ubuntu"])).toBe("Ubuntu")
    expect(parseWslDistroArg(["--distribution", "Debian", "--cd", "~"])).toBe("Debian")
  })
  it("is undefined when no distro flag is present", () => {
    expect(parseWslDistroArg([])).toBeUndefined()
    expect(parseWslDistroArg(["--cd", "~"])).toBeUndefined()
  })
})

describe("parseLoginShell", () => {
  it("takes the last field of a getent passwd line", () => {
    expect(parseLoginShell("me:x:1000:1000:Me:/home/me:/usr/bin/zsh")).toBe("/usr/bin/zsh")
    expect(parseLoginShell("root:x:0:0:root:/root:/bin/bash\n")).toBe("/bin/bash")
  })
  it("returns empty for a malformed line", () => {
    expect(parseLoginShell("garbage")).toBe("")
  })
})

describe("wslInjection", () => {
  const base = "/mnt/c/Users/me/AppData/Local/Temp/minmux/shell-integration"

  it("bash → --rcfile with the WSL-translated path", () => {
    const r = wslInjection("/bin/bash", base)
    expect(r?.args).toEqual(["--", "bash", "--rcfile", `${base}/bash/bashrc`, "-i"])
    expect(r?.wslenv).toEqual([
      "MINMUX_SHARE_HISTORY", // opt-out crosses the boundary
      "MINMUX_CLAUDE_SETTINGS/p", // hook settings path (path-translated)
      "MINMUX_AGENT_EVENTS/p", // the agents' drop root (path-translated)
      "MINMUX_PANE_ID", // agents-board pane tag
      "COLORFGBG", // light/dark theme signal for agents in WSL
    ])
  })

  it("zsh → ZDOTDIR + MINMUX_ZDOTDIR forwarded across the WSL boundary", () => {
    const r = wslInjection("/usr/bin/zsh", base)
    expect(r?.args).toEqual(["--", "zsh", "-i"])
    expect(r?.env.ZDOTDIR).toBe(`${base}/zsh`)
    expect(r?.env.MINMUX_ZDOTDIR).toBe(`${base}/zsh`) // lets the HISTFILE-repoint fire in WSL
    expect(r?.wslenv).toContain("ZDOTDIR")
    expect(r?.wslenv).toContain("MINMUX_ZDOTDIR")
    expect(r?.wslenv).toContain("MINMUX_CLAUDE_SETTINGS/p") // hooks reach claude inside WSL
    expect(r?.wslenv).toContain("MINMUX_AGENT_EVENTS/p") // …and can write their drops
    expect(r?.wslenv).toContain("MINMUX_PANE_ID")
    expect(r?.wslenv).toContain("COLORFGBG") // light/dark theme signal for agents in WSL
  })

  it("unsupported shells (fish) → null (plain shell, no integration)", () => {
    expect(wslInjection("/usr/bin/fish", base)).toBeNull()
  })
})

describe("buildInjection", () => {
  it("zsh → ZDOTDIR wrapper, no extra args", () => {
    const inj = buildInjection("/bin/zsh")
    expect(inj?.args).toEqual([])
    expect(inj?.env.MINMUX_SHELL_INTEGRATION).toBe("1")
    expect(inj?.env.ZDOTDIR).toContain("zsh")
  })

  it("bash → --rcfile", () => {
    const inj = buildInjection("/bin/bash")
    expect(inj?.args[0]).toBe("--rcfile")
    expect(inj?.env.MINMUX_SHELL_INTEGRATION).toBe("1")
  })

  it("unsupported shells → null", () => {
    expect(buildInjection("/usr/bin/fish")).toBeNull()
    expect(buildInjection("powershell.exe")).toBeNull()
  })
})

describe("precmd mouse-mode reset", () => {
  // Disables for X10/normal (1000), button-event (1002), any-event (1003) tracking
  // + SGR encoding (1006): the sequence that heals a crashed TUI's leftover mouse mode.
  const disables = ["1000l", "1002l", "1003l", "1006l"]

  it("zsh precmd emits every mouse-tracking disable", () => {
    for (const d of disables) expect(ZSH_ZSHRC).toContain(`\\033[?${d}`)
    // Must come after `local ret=$?` so the extra printf can't clobber the exit code.
    expect(ZSH_ZSHRC.indexOf("local ret=$?")).toBeLessThan(ZSH_ZSHRC.indexOf("\\033[?1003l"))
  })

  it("bash precmd emits every mouse-tracking disable", () => {
    for (const d of disables) expect(BASH_RC).toContain(`\\033[?${d}`)
    expect(BASH_RC.indexOf("local ret=$?")).toBeLessThan(BASH_RC.indexOf("\\033[?1003l"))
  })
})

describe("shared history (cmux-like)", () => {
  it("zsh enables SHARE_HISTORY, gated by the opt-out env, after the user's rc", () => {
    expect(ZSH_ZSHRC).toContain("setopt SHARE_HISTORY")
    expect(ZSH_ZSHRC).toContain('"${MINMUX_SHARE_HISTORY:-1}" != "0"')
    // Must run after sourcing the user's .zshrc so our setopt wins.
    expect(ZSH_ZSHRC.indexOf('source "$ZDOTDIR/.zshrc"')).toBeLessThan(
      ZSH_ZSHRC.indexOf("setopt SHARE_HISTORY"),
    )
  })

  it("zsh repoints a HISTFILE a system zshrc pointed into our ZDOTDIR back to the real one", () => {
    // A system zshrc (e.g. macOS /etc/zshrc) runs before our rc with HISTFILE derived from
    // ZDOTDIR (= our injected dir), siloing history. Match ANY file inside our dir + keep
    // the basename, guarded by -n so it never fires when MINMUX_ZDOTDIR is empty.
    expect(ZSH_ZSHRC).toContain('-n "${MINMUX_ZDOTDIR-}"')
    expect(ZSH_ZSHRC).toContain('"${HISTFILE-}" == "${MINMUX_ZDOTDIR-}"/*')
    expect(ZSH_ZSHRC).toContain('HISTFILE="${MINMUX_USER_ZDOTDIR:-$HOME}/${HISTFILE:t}"')
    // The repoint must run before SHARE_HISTORY is enabled (so it reads/writes the right file)…
    expect(ZSH_ZSHRC.indexOf('"${HISTFILE-}" == "${MINMUX_ZDOTDIR-}"/*')).toBeLessThan(
      ZSH_ZSHRC.indexOf("setopt SHARE_HISTORY"),
    )
    // …and OUTSIDE the shared-history opt-out gate — it's a correctness fix that must run
    // even when MINMUX_SHARE_HISTORY=0 (guards against a refactor folding it into that `if`).
    expect(ZSH_ZSHRC.indexOf('"${HISTFILE-}" == "${MINMUX_ZDOTDIR-}"/*')).toBeLessThan(
      ZSH_ZSHRC.indexOf('"${MINMUX_SHARE_HISTORY:-1}" != "0"'),
    )
  })

  it("bash appends + re-reads history each prompt, gated by the opt-out env", () => {
    expect(BASH_RC).toContain("shopt -s histappend")
    expect(BASH_RC).toContain("history -a; history -n")
    expect(BASH_RC).toContain('"${MINMUX_SHARE_HISTORY:-1}" != "0"')
    // The sync runs after `local ret=$?` so it can't clobber the reported exit code.
    expect(BASH_RC.indexOf("local ret=$?")).toBeLessThan(BASH_RC.indexOf("history -a; history -n"))
  })

  it("bash: PROMPT_COMMAND pieces (starship, direnv…) never emit a spurious command-start", () => {
    expect(BASH_RC).toContain('[[ "$BASH_COMMAND" == __minmux_* ]] && return')
    expect(BASH_RC).toContain("[[ $__minmux_in_pc == 1 ]] && return")
    // newline-joined (a user value ending in ';' must not become '; ;' — a syntax error),
    // and array-form PROMPT_COMMAND (bash 5.1+) wrapped element-wise
    expect(BASH_RC).toContain("__minmux_pc_end'")
    expect(BASH_RC).not.toContain("; __minmux_pc_end")
    expect(BASH_RC).toContain(
      'PROMPT_COMMAND=(__minmux_precmd "${PROMPT_COMMAND[@]}" __minmux_pc_end)',
    )
    // starts armed: the rc's own remaining lines must not emit a C before the first prompt
    expect(BASH_RC).toContain("__minmux_armed=1")
    // precmd opens the window AFTER capturing $? (the D exit code must be the user's command's)
    expect(BASH_RC.indexOf("local ret=$?")).toBeLessThan(BASH_RC.indexOf("__minmux_in_pc=1"))
  })
})

describe("buildInjection — per-profile script dir", () => {
  afterEach(() => setIntegrationDirName("minmux"))

  it("each profile writes its own scripts (a dev build never rewrites the installed app's)", () => {
    const def = buildInjection("/bin/zsh")!
    expect(def.env.ZDOTDIR).toBe(path.join(os.tmpdir(), "minmux", "shell-integration", "zsh"))
    setIntegrationDirName("minmux-dev")
    const dev = buildInjection("/bin/zsh")!
    expect(dev.env.ZDOTDIR).toBe(path.join(os.tmpdir(), "minmux-dev", "shell-integration", "zsh"))
    const bash = buildInjection("/bin/bash")!
    expect(bash.args[bash.args.length - 1]).toBe(
      path.join(os.tmpdir(), "minmux-dev", "shell-integration", "bash", "bashrc"),
    )
  })
})

describe("agent wrappers (electron/agents)", () => {
  const wrapper =
    /function claude \{ command claude --settings "\$MINMUX_CLAUDE_SETTINGS" "\$@";? \}/g
  it("go into the local zsh and bash rc once, after the user's rc and our hooks", () => {
    expect(ZSH_ZSHRC.match(wrapper)).toHaveLength(1)
    expect(BASH_RC.match(wrapper)).toHaveLength(1)
    expect(ZSH_ZSHRC.indexOf("function claude")).toBeGreaterThan(
      ZSH_ZSHRC.indexOf("__MINMUX_ZSH_HOOKS=1"),
    )
    expect(BASH_RC.indexOf("function claude")).toBeGreaterThan(
      BASH_RC.indexOf("trap '__minmux_preexec'"),
    )
  })
  it("stay out of the hooks an ssh host gets (no agent is armed there)", () => {
    expect(BASH_HOOKS).not.toContain("function claude")
    expect(ZSH_HOOKS).not.toContain("function claude")
  })
})
