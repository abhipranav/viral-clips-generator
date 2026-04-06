#!/usr/bin/env bash
set -euo pipefail

API_URL="${API_URL:-http://127.0.0.1:3001}"

echo "Checking ${API_URL}/readyz"
response="$(curl -fsS --max-time 10 "${API_URL}/readyz")"

if command -v python3 >/dev/null 2>&1; then
  echo "${response}" | python3 -m json.tool
else
  echo "${response}"
fi
