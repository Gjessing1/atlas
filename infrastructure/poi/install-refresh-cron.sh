#!/usr/bin/env bash
# Install/update the owning user's every-other-month Europe POI refresh.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MARKER="# Atlas Europe POI refresh — installed by infrastructure/poi/install-refresh-cron.sh"
POI_DIR="${ATLAS_POI_DIR:-}"
ENV_PREFIX=""
if [[ -n "$POI_DIR" ]]; then
  printf -v QUOTED_POI_DIR '%q' "$POI_DIR"
  ENV_PREFIX="ATLAS_POI_DIR=$QUOTED_POI_DIR "
fi
COMMAND="0 3 1 */2 * /usr/bin/bash -o pipefail -c '${ENV_PREFIX}$SCRIPT_DIR/refresh-pois.sh 2>&1 | /usr/bin/logger -t atlas-poi-refresh'"
TEMP="$(mktemp)"
trap 'rm -f "$TEMP"' EXIT

crontab -l 2>/dev/null \
  | grep -Fv "$MARKER" \
  | grep -Fv "$SCRIPT_DIR/refresh-pois.sh" \
  > "$TEMP" || true
printf '%s\n%s\n' "$MARKER" "$COMMAND" >> "$TEMP"
crontab "$TEMP"
echo "Installed: $COMMAND"
