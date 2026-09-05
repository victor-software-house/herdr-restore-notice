#!/bin/sh
# Small POSIX installer: consumers need no Bun, Node, GitHub login or compiler.
set -eu
version=$(awk -F '"' '/^version = "/ { print $2; exit }' herdr-plugin.toml)
[ -n "$version" ] || { printf '%s\n' 'Missing manifest version' >&2; exit 1; }
case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) platform=darwin-arm64 ;;
  Linux-x86_64) platform=linux-x64 ;;
  *) printf '%s\n' 'Supported: Apple Silicon macOS and x86_64 Linux.' >&2; exit 1 ;;
esac
asset="restore-notice-$platform.tar.gz"
url="https://github.com/victor-software-house/herdr-restore-notice/releases/download/v$version"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT HUP INT TERM
curl --fail --location --silent --show-error "$url/$asset" -o "$tmp/$asset"
curl --fail --location --silent --show-error "$url/$asset.sha256" -o "$tmp/$asset.sha256"
case "$platform" in
  darwin-arm64) (cd "$tmp" && shasum -a 256 -c "$asset.sha256") ;;
  linux-x64) (cd "$tmp" && sha256sum -c "$asset.sha256") ;;
esac
tar -xzf "$tmp/$asset" -C "$tmp" restore-notice
mkdir -p bin
chmod 755 "$tmp/restore-notice"
mv "$tmp/restore-notice" bin/restore-notice
printf 'Installed Restore Notice %s (%s)\n' "$version" "$platform"
