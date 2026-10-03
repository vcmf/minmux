# SSH hosts

How minmux lists and opens the hosts in your `~/.ssh/config`. Design and costs:
[`design/SSH_REMOTES.md`](design/SSH_REMOTES.md).

minmux reads the hosts from your `~/.ssh/config` (including `Include`d files). **Connect to
host…** (the sidebar's search icon, the palette, or the new-tab menu's "All hosts…") lists them:
pinned first, then recent, then the rest. Enter opens a tab, ⌥Enter splits right, ⇧Enter
splits down, and right-click pins, hides or copies the `ssh` command. The sidebar's **Remote**
section keeps just the hosts you pinned or have open. It never keeps its own host list,
passwords or keys: a click runs the system `ssh <alias>`, so keys, `ssh-agent`, 1Password, `ProxyJump` and password or 2FA prompts all work as
in any terminal. Editing the config updates the list as you save. Wildcard patterns
(`Host *.corp`) aren't listed. Git hosts (`github.com`, `gitlab.com`, …) are hidden by default;
show one again from the picker's "Hidden" footer (recorded in `ssh.shown`). Hide your own hosts
with right-click → Hide host, or `"ssh": { "hidden": ["bastion"] }`; that list adds to the git
defaults, it doesn't replace them. Hiding is by alias, so it applies in every environment.

- **Know where you are.** A remote pane's header shows where it runs (`user@hostname` from your
  config, else the alias). Give hosts a colour with `ssh.colors`: ssh-style patterns such as
  `prod-*` or `prod-*,db-*,!db-test`, first match wins (keep pattern keys non-numeric: JSON
  orders number-like keys first). The header, its tab and the sidebar carry it, so a
  production shell doesn't look like a scratch box.
- **Splits stay on the host.** Splitting an SSH pane, or opening a new terminal in it, opens
  another `ssh` to the same host. "Open folder in split" stays local.
- **Keepalive.** minmux adds `ServerAliveInterval=30` (with `ServerAliveCountMax=4`), so an idle
  pane survives NAT timeouts and a dead link ends in about two minutes instead of hanging.
  `"ssh": { "keepAliveSeconds": 0 }` leaves it to your config.
- **Which folder.** If the host reports its folder (OSC 7, or the Debian/Ubuntu title
  `user@host: ~/dir`), the sidebar row shows it, with the host boxed beside it. It's display
  only: a reconnect or a relaunch opens a fresh login at home (keeping your place across drops
  is what tmux persistence will do). With shell integration on, the folder and the pane's
  running / idle status come from minmux's own hooks on the host, and text a program prints
  can't fake them — and a split, a reconnect or a relaunch opens in that folder again (on
  the same machine; a folder that's gone just says so).
- **Reconnect.** When `ssh` exits, the pane says why and Enter (or the **Reconnect** button)
  connects again. A connection that was up for 30 s (after its last password prompt) and then
  loses its link (ssh says so: "closed by remote host", "Broken pipe", …) reconnects on its
  own, up to three times in a row (after 2, 5 and 10 s) and six in all until you reconnect it
  yourself. Each try is a fresh login shell, so a `RemoteCommand` in your config runs again. A
  clean `exit`, a logout, a drop at a password prompt, or one that fails straight away never
  does; `"ssh": { "autoReconnect": false }` turns it off. After a relaunch SSH panes reconnect
  as they're shown; with `"ssh": { "restore": "on-focus" }` they wait for Enter instead, which
  is handy for password or 2FA hosts. **Connect all** (beside the bell once two or more wait,
  and in the palette) connects every waiting one, including those in tabs you haven't opened
  yet: the first pane per host, then the rest once it's past its password prompt, so they can
  share a ControlMaster.
- **Shell integration.** It's what makes a split, a reconnect or a relaunch open in the same
  folder on a host, and its status exact. By default minmux asks: the first time you split an
  ssh pane on a host you haven't decided for, a one-line hint offers **Turn on** / **Never**. Or right-click a host → Turn on shell integration, or pick **All hosts** / **Off**
  in Settings → SSH (`ssh.integrationMode`; with "all", `!alias` entries in `ssh.integration`
  are the exceptions). A host that has it starts your bash or zsh with minmux's prompt hooks,
  sent inline for that session: nothing is installed, your dotfiles still load, and the temp
  files are gone once the shell has started. Other shells, a `RemoteCommand` in your config,
  or a host without `sh` get the plain login shell. (sshd skips the MOTD / "Last login" lines
  when minmux sends its command.) Details and costs: [design/SSH_REMOTES.md](design/SSH_REMOTES.md) §8.
- **Prompt-free splits.** Each pane is its own `ssh`. For hosts that ask for a password, let
  OpenSSH share one connection by adding this to your `~/.ssh/config`:

  ```
  Host *
    ControlMaster auto
    ControlPath ~/.ssh/cm-%C
    ControlPersist 10m
  ```

- **WSL.** On Windows, the hosts in each running WSL distro's `~/.ssh/config` are listed too and
  connect with that distro's own `ssh`.
- The Changes and Files panels show local folders only, so for an SSH pane they say it's remote.
