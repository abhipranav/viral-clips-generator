#!/usr/bin/env bash
set -euo pipefail

echo "Memory summary"
free -h
echo

echo "Swap summary"
swapon --show || true
echo

echo "Top memory consumers"
ps -eo pid,ppid,%mem,%cpu,cmd --sort=-%mem | head -n 15
