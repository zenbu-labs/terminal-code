#!/bin/bash
# Builds one release tarball for one target, plus the manifest the publish step
# reads. The tree it stages mirrors the repo — dist/, assets/, config/ — so the
# same __dirname resolution finds the install root from a checkout and from an
# install.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VERSION="${1:-dev}"
CHANNEL="${2:-dev}"
TARGET="${3:-darwin-arm64}"
OUT="$ROOT/dist-release"
STAGE="$OUT/tode"

HOST="$(uname -s | tr '[:upper:]' '[:lower:]')-$(uname -m | sed 's/aarch64/arm64/; s/x86_64/x64/')"
[ "$HOST" = "$TARGET" ] || { echo "building $TARGET on a $HOST machine is not possible" >&2; exit 1; }
PIXEL_VERSION="$(node -p 'require("./node_modules/@zenbu-labs/pixel/package.json").version')"

echo "tode $VERSION ($CHANNEL) for $TARGET, pixel $PIXEL_VERSION"

rm -rf "$OUT"
mkdir -p "$STAGE"

echo "==> compiling"
(cd "$ROOT" && npm run -s build)

echo "==> staging"
cp -R "$ROOT/dist" "$STAGE/dist"
cp -R "$ROOT/assets" "$STAGE/assets"
[ -d "$ROOT/config" ] && cp -R "$ROOT/config" "$STAGE/config"
echo "$VERSION" > "$STAGE/VERSION"
echo "$CHANNEL" > "$STAGE/CHANNEL"

echo "==> vendoring dependencies"
cp "$ROOT/package.json" "$ROOT/package-lock.json" "$STAGE/"
(cd "$STAGE" && npm ci --omit=dev)
rm -f "$STAGE/package-lock.json"

# The shim the installer copies to $XDG_BIN_HOME. It runs the CLI with the
# vendored electron in node mode, so an install needs no node of its own. On
# macOS the helper binary is used: its Info.plist sets LSUIElement, so no icon
# ever appears in the Dock while the CLI runs.
mkdir -p "$STAGE/bin"
case "$TARGET" in
  darwin-*)
    cat > "$STAGE/bin/tode" <<'SHIM'
#!/bin/sh
ROOT="${TODE_INSTALL_ROOT:-$HOME/.local/lib/tode}"
APP="$ROOT/node_modules/@zenbu-labs/pixel/electron/dist/Electron.app/Contents"
HELPER="$APP/Frameworks/Electron Helper.app/Contents/MacOS/Electron Helper"
[ -x "$HELPER" ] || HELPER="$APP/MacOS/pixel"
export ELECTRON_RUN_AS_NODE=1
exec "$HELPER" "$ROOT/dist/main.js" "$@"
SHIM
    ELECTRON_PIECE="$STAGE/node_modules/@zenbu-labs/pixel/electron/dist/Electron.app"
    ;;
  linux-*)
    cat > "$STAGE/bin/tode" <<'SHIM'
#!/bin/sh
ROOT="${TODE_INSTALL_ROOT:-$HOME/.local/lib/tode}"
export ELECTRON_RUN_AS_NODE=1
exec "$ROOT/node_modules/@zenbu-labs/pixel/electron/dist/pixel" "$ROOT/dist/main.js" "$@"
SHIM
    ELECTRON_PIECE="$STAGE/node_modules/@zenbu-labs/pixel/electron/dist/pixel"
    ;;
  *)
    echo "no shim recipe for $TARGET" >&2
    exit 1
    ;;
esac
chmod +x "$STAGE/bin/tode"

[ -f "$STAGE/node_modules/@zenbu-labs/pixel/dist/bootstrap.js" ] \
  && [ -e "$ELECTRON_PIECE" ] \
  || { echo "the vendored pixel is missing pieces" >&2; exit 1; }

echo "==> packing"
TARBALL="$OUT/tode-$TARGET.tar.gz"
tar -czf "$TARBALL" -C "$OUT" tode

if command -v sha256sum >/dev/null 2>&1; then
  SHA256="$(sha256sum "$TARBALL" | cut -d' ' -f1)"
else
  SHA256="$(shasum -a 256 "$TARBALL" | cut -d' ' -f1)"
fi
SIZE="$(wc -c < "$TARBALL" | tr -d ' ')"

cat > "$OUT/manifest-$TARGET.json" <<EOF
{
  "version": "$VERSION",
  "channel": "$CHANNEL",
  "platform": "$TARGET",
  "file": "$(basename "$TARBALL")",
  "sha256": "$SHA256",
  "size": $SIZE,
  "pixel": "$PIXEL_VERSION",
  "published": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOF

rm -rf "$STAGE"
echo "built $(basename "$TARBALL") — $((SIZE / 1000000)) MB"
