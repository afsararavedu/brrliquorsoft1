#!/usr/bin/env bash
# Build a complete production release of BRR Liquor Soft (api-server + brr-web).
# Works on AWS EC2 and Hostinger KVM 2 VPS (both run Linux x86-64).
#
# Output layout (under ./release/):
#   release/
#     api/                # self-contained api-server bundle
#       dist/             # esbuild output for the api-server
#       node_modules/     # all runtime deps (created by `pnpm deploy`)
#       package.json
#     web/                # static site to serve from nginx (root = release/web)
#     VERSION             # short git SHA + UTC timestamp
#
# Re-running this script is safe: ./release is wiped and rebuilt each time.
#
# Usage:
#   bash scripts/deploy/build-release.sh

set -euo pipefail

# Resolve repo root from this script's location so the script works regardless
# of where it's invoked from.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$REPO_ROOT"

RELEASE_DIR="$REPO_ROOT/release"

log() { printf '\033[1;34m[build-release]\033[0m %s\n' "$*"; }

if ! command -v pnpm >/dev/null 2>&1; then
  echo "error: pnpm is not installed or not on PATH" >&2
  echo "  install with: corepack enable && corepack prepare pnpm@latest --activate" >&2
  exit 1
fi

# pnpm-workspace.yaml uses onlyBuiltDependencies (introduced in pnpm v10).
# Older pnpm versions skip esbuild's install script → no binary → build fails.
# Auto-upgrade to the latest pnpm when the installed major version is < 10.
PNPM_MAJOR=$(pnpm --version 2>/dev/null | cut -d. -f1)
if [ "${PNPM_MAJOR:-0}" -lt 10 ]; then
  log "pnpm v${PNPM_MAJOR} detected (need v10+) — upgrading via npm install -g"
  npm install -g pnpm@latest
  log "pnpm upgraded to $(pnpm --version)"
fi

log "wiping previous release/ directory"
rm -rf "$RELEASE_DIR"
mkdir -p "$RELEASE_DIR/web"

log "step 1/5: pnpm install"
# pnpm may exit non-zero with an EACCES warning when it can't scandir a
# node_modules sub-folder (e.g. owned by root because pnpm was run as root
# once, or the pnpm store lives in /root/.local/share/pnpm).
# The packages ARE present when the lockfile is up to date, so we only
# abort if the esbuild binary — the only build tool this script needs —
# is actually missing.
pnpm install --frozen-lockfile || {
  EXIT=$?
  ESBUILD_BIN="$REPO_ROOT/node_modules/.bin/esbuild"
  if [ -x "$ESBUILD_BIN" ]; then
    log "  pnpm install exited $EXIT (likely a store EACCES) but esbuild is present — continuing"
  else
    echo "[build-release] pnpm install failed and esbuild is missing." >&2
    echo "  Fix ownership then retry:" >&2
    echo "    sudo chown -R \$(whoami):\$(whoami) /opt/brr/repo" >&2
    exit $EXIT
  fi
}

log "step 2/5: regenerate API client + zod schemas from OpenAPI spec"
pnpm --filter @workspace/api-spec run codegen

log "step 3/5: build api-server (esbuild)"
pnpm --filter @workspace/api-server run build

log "step 4/5: build web frontend (vite)"
# vite.config.ts requires PORT and BASE_PATH to be set even at build time.
# PORT is irrelevant for static output (only used by the dev/preview server),
# so any value is fine. BASE_PATH controls where assets are served from in
# production -- "/" means the site is served at the domain root.
PORT=80 BASE_PATH=/ pnpm --filter @workspace/brr-web run build

log "step 5/5: assemble release/ folder"

# Use `pnpm deploy` to create a self-contained api/ directory that includes
# a proper node_modules/ with all runtime dependencies resolved (including
# externalized packages like connect-pg-simple, pdf-parse, bcryptjs, etc.).
# This avoids the problem of externalized packages being unreachable at runtime
# when the bundle runs outside the monorepo's node_modules tree.
log "  assembling release/api/ with npm install (pnpm-version-agnostic)..."
mkdir -p "$RELEASE_DIR/api"

# Write a clean package.json with exact runtime deps — no workspace: refs
# so this works with any npm/node version on any machine (EC2, CI, etc.).
cat > "$RELEASE_DIR/api/package.json" << 'EOF'
{
  "name": "brr-api-server",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": { "start": "node --enable-source-maps ./dist/index.mjs" },
  "dependencies": {
    "bcryptjs": "^3.0.3",
    "connect-pg-simple": "^10.0.0",
    "cookie-parser": "^1.4.7",
    "cors": "^2",
    "dotenv": "^16.0.0",
    "drizzle-orm": "^0.45.2",
    "express": "^5",
    "express-session": "^1.18.2",
    "memorystore": "^1.6.7",
    "multer": "^2.0.2",
    "passport": "^0.7.0",
    "passport-local": "^1.0.0",
    "pdf-parse": "1.1.1",
    "pg": "^8.16.3",
    "pino": "^9",
    "pino-http": "^10",
    "xlsx": "^0.18.5",
    "zod": "^3.25.76"
  }
}
EOF

# Install runtime deps using plain npm (works with npm v8+ regardless of pnpm version)
log "  running npm install --omit=dev in release/api/"
(cd "$RELEASE_DIR/api" && npm install --omit=dev --no-fund --no-audit 2>&1)

# Copy the compiled esbuild bundle into the release folder
log "  copying compiled dist/ into release/api/"
cp -R artifacts/api-server/dist/. "$RELEASE_DIR/api/dist/"

# Copy committed SQL migration files so the api-server can apply them at
# startup via drizzle-orm's migrate() — drizzle-kit is NOT needed on EC2.
log "  copying lib/db/migrations/ into release/api/migrations/"
cp -R lib/db/migrations/. "$RELEASE_DIR/api/migrations/"

# web: vite outputs to artifacts/brr-web/dist/public
cp -R artifacts/brr-web/dist/public/. "$RELEASE_DIR/web/"

# Stamp the release with a VERSION marker so you can tell what's deployed.
{
  echo "git_sha=$(git rev-parse --short HEAD 2>/dev/null || echo unknown)"
  echo "built_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
} > "$RELEASE_DIR/VERSION"

log "done."
log "release/ contents:"
( cd "$RELEASE_DIR" && find . -maxdepth 3 -mindepth 1 | sort )

# Pack the release folder into a single tar.gz so it can be downloaded from
# the Replit file browser and uploaded directly to any EC2 / VPS instance
# without needing git or build tools on the server.
TAR_FILE="brr-liquor-soft-release.tar.gz"
log "packaging → ${TAR_FILE}"
tar -czf "$TAR_FILE" -C . release/
log "✓ ${TAR_FILE} ready ($(du -sh "$TAR_FILE" | cut -f1))"
log "  Download it from the Replit file browser, then on EC2 run:"
log "    sudo tar -xzf ${TAR_FILE} -C /opt/brr && sudo systemctl restart brr-api"
