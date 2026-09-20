#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
POI_DOWNLOAD=1 exec "$SCRIPT_DIR/build-pois.sh"
