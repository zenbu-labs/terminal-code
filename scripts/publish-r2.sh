#!/bin/bash
# Merges the per-target manifests, uploads the tarballs and the installer to R2,
# and only then moves latest.json. That order matters: if an upload fails, the
# channel still points at the last version whose bytes are all present.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${1:-$ROOT/dist-release}"
BUCKET="${R2_BUCKET:-tode-releases}"

MANIFESTS=("$OUT"/manifest-*.json)
[ -f "${MANIFESTS[0]}" ] || { echo "no per-target manifests in $OUT" >&2; exit 1; }

MANIFEST="$OUT/manifest.json"
node - "$MANIFEST" "${MANIFESTS[@]}" <<'EOF'
const fs = require("fs");
const [outPath, ...paths] = process.argv.slice(2);
const platforms = {};
let version, channel, published;
for (const path of paths) {
  const m = JSON.parse(fs.readFileSync(path, "utf8"));
  if (version && (m.version !== version || m.channel !== channel)) {
    console.error(`manifest mismatch: ${path} is ${m.channel}/${m.version}, expected ${channel}/${version}`);
    process.exit(1);
  }
  ({ version, channel } = m);
  published = m.published;
  platforms[m.platform] = { file: m.file, sha256: m.sha256, size: m.size };
}
fs.writeFileSync(outPath, `${JSON.stringify({ version, channel, published, platforms }, null, 2)}\n`);
EOF

field() { node -p "require('$MANIFEST').$1"; }
VERSION="$(field version)"
CHANNEL="$(field channel)"

wr() { (cd "$ROOT/release-worker" && npx --no-install wrangler@4.120.0 "$@"); }

put() {
  local size
  size=$(($(wc -c < "$2")))
  # wrangler uploads in one request, and the API caps that near 315 MB
  if [ "$size" -gt 300000000 ]; then
    echo "$2 is $size bytes — too big for a single-request upload, needs multipart" >&2
    exit 1
  fi
  wr r2 object put "$BUCKET/$1" --file "$2" --remote --content-type "$3" ${4:+--cache-control "$4"}
}

for target_manifest in "${MANIFESTS[@]}"; do
  file="$(node -p "require('$target_manifest').file")"
  echo "uploading $file"
  put "$CHANNEL/$VERSION/$file" "$OUT/$file" application/gzip
done

PLATFORMS="$(node -p "Object.keys(require('$MANIFEST').platforms).join(', ')")"
echo "publishing $CHANNEL/$VERSION ($PLATFORMS)"
# The installer is stored per version, so a pinned url always serves the script
# that shipped with that build.
put "$CHANNEL/$VERSION/install.sh" "$ROOT/scripts/install.sh" text/x-shellscript
put "$CHANNEL/$VERSION/manifest.json" "$MANIFEST" application/json

if [ "${FLIP_LATEST:-true}" = "true" ]; then
  put "$CHANNEL/latest.json" "$MANIFEST" application/json no-store
  echo "published $VERSION to $CHANNEL"
else
  echo "published pinned $VERSION (latest.json untouched)"
fi

if [ -n "${RELEASE_ORIGIN:-}" ]; then
  echo "pinned=$RELEASE_ORIGIN/v/$VERSION"
  if [ "${FLIP_LATEST:-true}" = "true" ]; then
    if [ "$CHANNEL" = "stable" ]; then echo "latest=$RELEASE_ORIGIN"; else echo "latest=$RELEASE_ORIGIN/dev"; fi
  fi
fi
