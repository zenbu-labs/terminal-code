#!/bin/bash
set -euo pipefail



ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
LIB_HOME="$HOME/.local/lib"
BIN_HOME="${XDG_BIN_HOME:-$HOME/.local/bin}"
APP="${TODE_INSTALL_ROOT:-$LIB_HOME/tode}"
VERSION="dev-$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || echo local)-dirty"

echo "==> building"
(cd "$ROOT" && npm run -s build)

echo "==> staging $VERSION"
STAGE="$APP.new"
rm -rf "$STAGE"
mkdir -p "$STAGE"
cp -R "$ROOT/dist" "$STAGE/dist"
cp -R "$ROOT/assets" "$STAGE/assets"
[ -d "$ROOT/config" ] && cp -R "$ROOT/config" "$STAGE/config"
echo "$VERSION" > "$STAGE/VERSION"
echo "dev" > "$STAGE/CHANNEL"

echo "==> vendoring dependencies"
cp "$ROOT/package.json" "$ROOT/package-lock.json" "$STAGE/"
(cd "$STAGE" && npm ci --omit=dev --ignore-scripts >/dev/null)
ELECTRON_SRC="$(cd "$ROOT" && node -e 'console.log(require("path").dirname(require.resolve("@zenbu-labs/pixel/package.json")))')/electron"
mkdir -p "$STAGE/node_modules/@zenbu-labs/pixel/electron"
cp -R "$ELECTRON_SRC/dist" "$STAGE/node_modules/@zenbu-labs/pixel/electron/dist"
cp "$ELECTRON_SRC/electron.d.ts" "$ELECTRON_SRC/.electron.d.ts.source" "$STAGE/node_modules/@zenbu-labs/pixel/electron/"
rm -f "$STAGE/package-lock.json"

# the same shims release.sh ships, chosen by this machine's platform
mkdir -p "$STAGE/bin"
case "$(uname -s)" in
  Darwin)
    cat > "$STAGE/bin/tode" <<'SHIM'
#!/bin/sh
ROOT="${TODE_INSTALL_ROOT:-$HOME/.local/lib/tode}"
APP="$ROOT/node_modules/@zenbu-labs/pixel/electron/dist/Electron.app/Contents"
HELPER="$APP/Frameworks/Electron Helper.app/Contents/MacOS/Electron Helper"
[ -x "$HELPER" ] || HELPER="$APP/MacOS/pixel"
export ELECTRON_RUN_AS_NODE=1
exec "$HELPER" "$ROOT/dist/main.js" "$@"
SHIM
    ;;
  Linux)
    cat > "$STAGE/bin/tode" <<'SHIM'
#!/bin/sh
ROOT="${TODE_INSTALL_ROOT:-$HOME/.local/lib/tode}"
export ELECTRON_RUN_AS_NODE=1
exec "$ROOT/node_modules/@zenbu-labs/pixel/electron/dist/pixel" "$ROOT/dist/main.js" "$@"
SHIM
    ;;
esac
chmod +x "$STAGE/bin/tode"

echo "==> installing to $APP"
rm -rf "$APP.old"
[ -d "$APP" ] && mv "$APP" "$APP.old"
mkdir -p "$(dirname "$APP")"
mv "$STAGE" "$APP"
rm -rf "$APP.old"

mkdir -p "$BIN_HOME"
cp "$APP/bin/tode" "$BIN_HOME/tode"
chmod +x "$BIN_HOME/tode"

echo "installed $VERSION"
echo "  app  $APP"
echo "  bin  $BIN_HOME/tode"
