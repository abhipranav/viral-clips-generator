#!/usr/bin/env bash
set -euo pipefail

SWAP_FILE="${SWAP_FILE:-/swapfile}"
SWAP_SIZE="${SWAP_SIZE:-2G}"

if swapon --show | grep -q "${SWAP_FILE}"; then
  echo "Swap file ${SWAP_FILE} is already active."
  exit 0
fi

echo "Creating swap file ${SWAP_FILE} (${SWAP_SIZE})"
sudo fallocate -l "${SWAP_SIZE}" "${SWAP_FILE}"
sudo chmod 600 "${SWAP_FILE}"
sudo mkswap "${SWAP_FILE}"
sudo swapon "${SWAP_FILE}"

if ! grep -q "${SWAP_FILE}" /etc/fstab; then
  echo "${SWAP_FILE} none swap sw 0 0" | sudo tee -a /etc/fstab >/dev/null
fi

echo "Swap configured successfully."
swapon --show
