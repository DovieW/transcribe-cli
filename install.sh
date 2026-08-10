#!/usr/bin/env bash
set -euo pipefail

REPOSITORY="${TRANSCRIBE_REPOSITORY:-DovieW/transcribe-cli}"
VERSION="${TRANSCRIBE_VERSION:-latest}"
INSTALL_DIR="${TRANSCRIBE_INSTALL_DIR:-${XDG_BIN_HOME:-$HOME/.local/bin}}"
ASSET="transcribe-linux-x64"

fail() {
  printf 'transcribe installer: %s\n' "$*" >&2
  exit 1
}

[[ "$(uname -s)" == "Linux" ]] || fail "prebuilt releases currently support Linux only"
case "$(uname -m)" in
  x86_64|amd64) ;;
  *) fail "prebuilt releases currently support x86-64 only" ;;
esac

command -v curl >/dev/null || fail "curl is required"
command -v sha256sum >/dev/null || fail "sha256sum is required"
command -v install >/dev/null || fail "install is required"

if [[ "$VERSION" == "latest" ]]; then
  RELEASE_URL="https://github.com/$REPOSITORY/releases/latest/download"
else
  [[ "$VERSION" == v* ]] || VERSION="v$VERSION"
  RELEASE_URL="https://github.com/$REPOSITORY/releases/download/$VERSION"
fi

TEMP_DIR="$(mktemp -d)"
trap 'rm -rf -- "$TEMP_DIR"' EXIT

curl -fL --retry 3 --output "$TEMP_DIR/$ASSET" "$RELEASE_URL/$ASSET"
curl -fL --retry 3 --output "$TEMP_DIR/$ASSET.sha256" "$RELEASE_URL/$ASSET.sha256"
(
  cd "$TEMP_DIR"
  sha256sum --check "$ASSET.sha256"
)

mkdir -p "$INSTALL_DIR"
install -m 0755 "$TEMP_DIR/$ASSET" "$INSTALL_DIR/transcribe"
printf 'Installed %s\n' "$INSTALL_DIR/transcribe"
printf 'Run: transcribe doctor\n'
