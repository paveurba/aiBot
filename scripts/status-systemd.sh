#!/usr/bin/env bash
set -euo pipefail

services=(
  aibot.service
  aibot-agent-worker.service
  aibot-stt-worker.service
  aibot-notify-worker.service
)

for svc in "${services[@]}"; do
  echo "[$svc]"
  systemctl --no-pager --full status "$svc" | sed -n '1,14p' || true
  echo
done
