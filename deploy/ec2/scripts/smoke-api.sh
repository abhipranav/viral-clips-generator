#!/usr/bin/env bash
set -euo pipefail

API_URL="${API_URL:-http://127.0.0.1:3001}"

echo "Running API smoke checks against ${API_URL}"
curl -fsS --max-time 10 "${API_URL}/health" >/dev/null
curl -fsS --max-time 10 "${API_URL}/readyz" >/dev/null
echo "Smoke checks passed."
