#!/usr/bin/env bash
set -euo pipefail

services=(
  aibot-notify-worker.service
  aibot-stt-worker.service
  aibot-agent-worker.service
  aibot.service
)

for svc in "${services[@]}"; do
  sudo systemctl disable --now "$svc" >/dev/null 2>&1 || true
  sudo rm -f "/etc/systemd/system/$svc"
  echo "Removed: $svc"
done

sudo systemctl daemon-reload

echo "Removed aiBot systemd services."
