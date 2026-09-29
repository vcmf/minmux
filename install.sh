#!/bin/sh
# minmux installer for macOS and Linux.
#   curl -fsSL https://raw.githubusercontent.com/vcmf/minmux/main/install.sh | sh
# Downloads the newest release for your OS from GitHub and drops it somewhere sensible.
# Terminal downloads are not Gatekeeper-quarantined, so on macOS this "just works"
# with no security prompt (unlike the browser .dmg, which is not notarized yet).
set -eu

REPO="vcmf/minmux"
API="https://api.github.com/repos/$REPO/releases?per_page=1"

say() { printf '  %s\n' "$1"; }
die() { printf '\nminmux install failed: %s\n' "$1" >&2; exit 1; }

command -v curl >/dev/null 2>&1 || die "curl is required"

printf '\nInstalling minmux...\n'
json="$(curl -fsSL "$API")" || die "could not reach GitHub"
tag="$(printf '%s' "$json" | grep -oE '"tag_name": *"[^"]+"' | head -1 | sed -E 's/.*"([^"]+)"$/\1/')"
[ -n "${tag:-}" ] && say "latest release: $tag"

os="$(uname -s)"
arch="$(uname -m)"

case "$os" in
  Darwin)
    [ "$arch" = "arm64" ] || die "only Apple Silicon (arm64) is built right now; yours is $arch"
    url="$(printf '%s' "$json" | grep -oE 'https://[^"]+-arm64-mac\.zip"' | tr -d '"' | head -1)"
    [ -n "$url" ] || die "no macOS build found in $tag"
    tmp="$(mktemp -d)"
    trap 'rm -rf "$tmp"' EXIT
    say "downloading $(basename "$url")"
    curl -fsSL "$url" -o "$tmp/minmux.zip" || die "download failed"
    /usr/bin/ditto -x -k "$tmp/minmux.zip" "$tmp" || die "could not unzip"
    # Releases before the rename ship smterm.app: install whichever bundle the archive holds.
    app=""
    for a in minmux.app smterm.app; do [ -d "$tmp/$a" ] && { app="$a"; break; }; done
    [ -n "$app" ] || die "archive did not contain minmux.app"
    dest="/Applications"
    [ -w "$dest" ] || dest="$HOME/Applications"
    mkdir -p "$dest"
    rm -rf "${dest:?}/$app"
    mv "$tmp/$app" "$dest/$app"
    xattr -dr com.apple.quarantine "$dest/$app" 2>/dev/null || true
    # The app used to be called smterm: drop the old bundle so there's one app, not two
    # (its settings and layout are carried over on first launch).
    if [ "$app" = minmux.app ] && [ -d "$dest/smterm.app" ]; then
      rm -rf "$dest/smterm.app" && say "removed the old $dest/smterm.app (now minmux)"
    fi
    say "installed to $dest/$app"
    printf '\nDone. Launch it from Spotlight, or: open "%s/%s"\n\n' "$dest" "$app"
    ;;
  Linux)
    url="$(printf '%s' "$json" | grep -oE 'https://[^"]+\.AppImage"' | tr -d '"' | head -1)"
    [ -n "$url" ] || die "no Linux build found in $tag"
    dest="${MINMUX_BIN:-${SMTERM_BIN:-$HOME/.local/bin}}"
    mkdir -p "$dest"
    say "downloading $(basename "$url")"
    curl -fsSL "$url" -o "$dest/minmux" || die "download failed"
    chmod +x "$dest/minmux"
    say "installed to $dest/minmux"
    # The app used to be called smterm: point the old name at the new binary, so a launcher,
    # alias or script that runs `smterm` keeps working.
    if [ -e "$dest/smterm" ] || [ -L "$dest/smterm" ]; then
      ln -sf minmux "$dest/smterm" && say "$dest/smterm now runs minmux (the app's old name)"
    fi
    case ":$PATH:" in
      *":$dest:"*) : ;;
      *) printf '\nNote: %s is not on your PATH. Add it, or run %s/minmux directly.\n' "$dest" "$dest" ;;
    esac
    printf '\nDone. Run: minmux\n\n'
    ;;
  *)
    die "unsupported OS: $os (this installer covers macOS and Linux; Windows uses install.ps1)"
    ;;
esac
