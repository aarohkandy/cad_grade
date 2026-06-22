#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_DIR="$REPO_ROOT/exports/live-backups/logs"
LOG_FILE="$LOG_DIR/hourly-backup-$(date +%F).log"

find_node() {
  local candidates=(
    "${NODE_BINARY:-}"
    "$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node"
    "/opt/homebrew/bin/node"
    "/usr/local/bin/node"
    "/usr/bin/node"
  )
  for candidate in "${candidates[@]}"; do
    if [[ -n "$candidate" && -x "$candidate" ]]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  if command -v node >/dev/null 2>&1; then
    command -v node
    return 0
  fi
  return 1
}

mkdir -p "$LOG_DIR"
cd "$REPO_ROOT"

STAMP="$(date -Iseconds)"
echo "[$STAMP] starting backup" >> "$LOG_FILE"

if ! NODE_PATH="$(find_node)"; then
  echo "[$STAMP] node not found" >> "$LOG_FILE"
  exit 127
fi

"$NODE_PATH" scripts/backup-live.mjs \
  --url https://cadbattle.vercel.app \
  --out exports/live-backups \
  --prune completed-hour >> "$LOG_FILE" 2>&1

EXIT_CODE=$?
DONE="$(date -Iseconds)"
echo "[$DONE] finished backup exit=$EXIT_CODE" >> "$LOG_FILE"
exit "$EXIT_CODE"
