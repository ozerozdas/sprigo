#!/bin/sh
# Installs the latest Sprigo release:
#   curl -fsSL https://raw.githubusercontent.com/ozerozdas/sprigo/master/install.sh | sh
# macOS: Sprigo.app into /Applications. Linux (x86_64, aarch64): the AppImage as ~/.local/bin/sprigo.
set -eu

repo="https://github.com/ozerozdas/sprigo"
tag=$(curl -fsSLI -o /dev/null -w '%{url_effective}' "$repo/releases/latest")
tag=${tag##*/}
version=${tag#v}
case $version in [0-9]*) ;; *) echo "Could not find the latest Sprigo release." >&2; exit 1 ;; esac

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

case "$(uname -s)" in
Darwin)
  case "$(uname -m)" in arm64) arch=aarch64 ;; *) arch=x64 ;; esac
  echo "Downloading Sprigo $version ($arch)..."
  curl -fL --progress-bar -o "$tmp/sprigo.dmg" "$repo/releases/download/$tag/Sprigo_${version}_${arch}.dmg"
  hdiutil attach -nobrowse -quiet -mountpoint "$tmp/mnt" "$tmp/sprigo.dmg"
  rm -rf /Applications/Sprigo.app
  ditto "$tmp/mnt/Sprigo.app" /Applications/Sprigo.app
  hdiutil detach -quiet "$tmp/mnt"
  # The app is not notarized yet; curl adds no quarantine flag, but clear it in case.
  xattr -dr com.apple.quarantine /Applications/Sprigo.app 2>/dev/null || true
  echo "Installed /Applications/Sprigo.app"
  ;;
Linux)
  case "$(uname -m)" in x86_64) arch=amd64 ;; aarch64|arm64) arch=aarch64 ;; *) echo "Sprigo for Linux is built for x86_64 and aarch64." >&2; exit 1 ;; esac
  dir="$HOME/.local/bin"
  mkdir -p "$dir"
  echo "Downloading Sprigo $version..."
  curl -fL --progress-bar -o "$tmp/sprigo" "$repo/releases/download/$tag/Sprigo_${version}_${arch}.AppImage"
  chmod +x "$tmp/sprigo"
  mv "$tmp/sprigo" "$dir/sprigo"
  echo "Installed $dir/sprigo (run: sprigo). The AppImage needs FUSE 2 (libfuse2)."
  case ":$PATH:" in *":$dir:"*) ;; *) echo "Add $dir to your PATH to run it by name." ;; esac
  ;;
*)
  echo "On Windows, download the installer from $repo/releases/latest" >&2
  exit 1
  ;;
esac
