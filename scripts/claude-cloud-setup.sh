#!/usr/bin/env bash
set -eo pipefail

# Project hooks also run locally; never change a local installation.
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"
NODE_VERSION="$(cat .nvmrc)"

if ! command -v node >/dev/null 2>&1 ||
   [ "$(node -p 'process.versions.node.split(".")[0]')" != "$NODE_VERSION" ]; then
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  if [ ! -s "$NVM_DIR/nvm.sh" ]; then
    echo "Claude cloud setup requires Node.js $NODE_VERSION or nvm in NVM_DIR. Configure the cloud environment; do not install Homebrew or change local settings." >&2
    exit 1
  fi
  . "$NVM_DIR/nvm.sh"
  nvm install "$NODE_VERSION"
  nvm use "$NODE_VERSION"
fi

if [ -n "${CLAUDE_ENV_FILE:-}" ]; then
  printf 'export PATH=%q:"$PATH"\n' "$(dirname "$(command -v node)")" >> "$CLAUDE_ENV_FILE"
fi

echo "Claude cloud setup: $(node --version), npm $(npm --version)"
npm ci --no-audit --no-fund
node --input-type=module <<'NODE'
import Database from 'better-sqlite3';
const db = new Database(':memory:');
try {
  if (db.prepare('SELECT 1 AS ok').get().ok !== 1) {
    throw new Error('Native SQLite smoke test failed');
  }
} finally {
  db.close();
}
NODE
npm run build
echo "Claude cloud setup complete. No credentials or global Claude settings were changed."
