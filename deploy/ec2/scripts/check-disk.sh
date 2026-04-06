#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="${ROOT_DIR:-/opt/jiang-clips}"

echo "Filesystem usage"
df -h
echo

echo "Project storage usage in ${ROOT_DIR}"
if [[ -d "${ROOT_DIR}/data" ]]; then
  du -sh "${ROOT_DIR}/data"
fi
if [[ -d "${ROOT_DIR}/output" ]]; then
  du -sh "${ROOT_DIR}/output"
fi
