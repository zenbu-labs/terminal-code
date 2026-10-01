#!/bin/bash
set -euo pipefail

VERSION="__VERSION__"
CHANNEL="__CHANNEL__"
# One row per target: target url sha256 size
PLATFORMS="__PLATFORMS__"

case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) TARGET=darwin-arm64 ;;
  Darwin-x86_64) TARGET=darwin-x64 ;;
  Linux-x86_64|Linux-amd64) TARGET=linux-x64 ;;
  Linux-aarch64|Linux-arm64) TARGET=linux-arm64 ;;
  *)
    echo "tode does not support $(uname -s) $(uname -m) yet" >&2
    exit 1
    ;;
esac

ROW="$(printf '%s\n' "$PLATFORMS" | awk -v t="$TARGET" '$1 == t')"
[ -n "$ROW" ] || { echo "tode $VERSION has no build for $TARGET" >&2; exit 1; }
URL="$(printf '%s\n' "$ROW" | awk '{print $2}')"
SHA256="$(printf '%s\n' "$ROW" | awk '{print $3}')"

# The program goes in lib, not in share. An upgrade replaces this tree whole,
# and share holds the vscode profile, the database and the browser data.
LIB_HOME="$HOME/.local/lib"
BIN_HOME="${XDG_BIN_HOME:-$HOME/.local/bin}"
STATE_HOME="${XDG_STATE_HOME:-$HOME/.local/state}"
DATA_HOME="${XDG_DATA_HOME:-$HOME/.local/share}"
APP="${TODE_INSTALL_ROOT:-$LIB_HOME/tode}"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "tode $VERSION ($CHANNEL) for $TARGET"

TARBALL="$TMP/tode.tar.gz"
curl -fL --retry 3 --retry-delay 2 --progress-bar "$URL" -o "$TARBALL"

if command -v sha256sum >/dev/null 2>&1; then
  CHECK="sha256sum -c -"
else
  CHECK="shasum -a 256 -c -"
fi
echo "$SHA256  $TARBALL" | $CHECK >/dev/null \
  || { echo "the download did not match its hash" >&2; exit 1; }

# Unpack beside the target and rename over it. A rename is atomic, so a failed
# install never leaves half a tree behind.
rm -rf "$APP.new"
mkdir -p "$APP.new"
tar -xzf "$TARBALL" -C "$APP.new" --strip-components 1

[ -f "$APP.new/dist/main.js" ] || { echo "the tarball is missing dist/main.js" >&2; exit 1; }

rm -rf "$APP.old"
[ -d "$APP" ] && mv "$APP" "$APP.old"
mkdir -p "$(dirname "$APP")"
mv "$APP.new" "$APP"
rm -rf "$APP.old"

mkdir -p "$BIN_HOME"
cp "$APP/bin/tode" "$BIN_HOME/tode"
chmod +x "$BIN_HOME/tode"

# the vendored electron needs the usual chromium system libraries; say which
# ones are missing rather than failing later with a loader error
if [ "$(uname -s)" = Linux ]; then
  MISSING="$(ldd "$APP/node_modules/@zenbu-labs/pixel/electron/dist/pixel" 2>/dev/null | awk '/not found/{print $1}' | sort -u || true)"
  if [ -n "$MISSING" ]; then
    echo "warning: missing system libraries:" >&2
    printf '  %s\n' $MISSING >&2
    echo "  sudo apt-get install libnss3 libgtk-3-0 libasound2t64 libgbm1" >&2
  fi
fi


mkdir -p "$STATE_HOME/tode"
cat > "$STATE_HOME/tode/install.json" <<EOF
{
  "version": "$VERSION",
  "channel": "$CHANNEL",
  "target": "$TARGET",
  "root": "$APP",
  "installed": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOF

echo
echo "tode $VERSION -> $APP"
echo "binary $BIN_HOME/tode"

# no setup questions here — the first open walks import and shortcuts itself

case ":$PATH:" in
  *":$BIN_HOME:"*)
    echo
    echo "run tode to get started"
    ;;
  *)
    echo
    echo "add $BIN_HOME to your PATH first:"
    case "${SHELL:-}" in
      */zsh)  echo "  echo 'export PATH=\"$BIN_HOME:\$PATH\"' >> ~/.zshrc && exec zsh" ;;
      */bash) echo "  echo 'export PATH=\"$BIN_HOME:\$PATH\"' >> ~/.bashrc && exec bash" ;;
      *)      echo "  export PATH=\"$BIN_HOME:\$PATH\"  (add it to your shell's rc file)" ;;
    esac
    ;;
esac
