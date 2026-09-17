#!/usr/bin/env bash
# Install/update the owning user's nightly NVDB check. A user crontab is used
# because the repository and dataset are both owned by this account; unlike a
# user systemd timer it also keeps running when the account has no login/linger
# session.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MARKER="# Atlas NVDB refresh — installed by infrastructure/nvdb/install-refresh-cron.sh"
COMMAND="17 2 * * * /usr/bin/bash -o pipefail -c '$SCRIPT_DIR/refresh-nvdb.sh 2>&1 | /usr/bin/logger -t atlas-nvdb-refresh'"
TEMP="$(mktemp)"
trap 'rm -f "$TEMP"' EXIT

# Idempotent across repository updates: remove only our marker and exact
# refresh command, preserving every unrelated crontab entry byte-for-byte.
crontab -l 2>/dev/null \
  | grep -Fv "$MARKER" \
  | grep -Fv "$SCRIPT_DIR/refresh-nvdb.sh" \
  > "$TEMP" || true
printf '%s\n%s\n' "$MARKER" "$COMMAND" >> "$TEMP"
crontab "$TEMP"
echo "Installed: $COMMAND"
