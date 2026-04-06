#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="${ROOT_DIR:-/opt/jiang-clips}"
AGE_DAYS="${AGE_DAYS:-7}"

echo "Cleaning run artifacts older than ${AGE_DAYS} days in ${ROOT_DIR}"

if [[ -d "${ROOT_DIR}/data/runs" ]]; then
  find "${ROOT_DIR}/data/runs" -mindepth 1 -maxdepth 1 -type d -mtime +"${AGE_DAYS}" -print -exec rm -rf {} +
fi

if [[ -d "${ROOT_DIR}/output" ]]; then
  find "${ROOT_DIR}/output" -mindepth 1 -maxdepth 1 -type d -mtime +"${AGE_DAYS}" -print -exec rm -rf {} +
fi

echo "Cleanup complete."
