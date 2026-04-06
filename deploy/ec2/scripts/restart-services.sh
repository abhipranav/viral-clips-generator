#!/usr/bin/env bash
set -euo pipefail

if ! command -v systemctl >/dev/null 2>&1; then
  echo "systemctl is not available on this machine."
  exit 1
fi

echo "Restarting API, web, and nginx services"
sudo systemctl restart jiang-clips-api jiang-clips-web nginx
sudo systemctl status --no-pager jiang-clips-api jiang-clips-web nginx
