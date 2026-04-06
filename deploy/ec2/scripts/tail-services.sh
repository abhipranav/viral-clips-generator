#!/usr/bin/env bash
set -euo pipefail

LINES="${LINES:-200}"

echo "Tailing jiang-clips service logs (last ${LINES} lines)"
sudo journalctl -u jiang-clips-api -u jiang-clips-web -n "${LINES}" -f
