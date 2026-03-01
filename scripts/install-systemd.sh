#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
USER_NAME="${AIBOT_USER:-$USER}"
GROUP_NAME="${AIBOT_GROUP:-$USER_NAME}"
NODE_BIN="${NODE_BIN:-$(command -v node || true)}"

if [[ -z "${NODE_BIN:-}" ]]; then
  echo "node binary not found in PATH"
  exit 1
fi

if [[ ! -f "$PROJECT_DIR/.env" ]]; then
  echo "warning: $PROJECT_DIR/.env not found"
fi

write_unit() {
  local service_name="$1"
  local entry_script="$2"
  local description="$3"
  local unit_path="/etc/systemd/system/${service_name}.service"

  sudo tee "$unit_path" >/dev/null <<UNIT
[Unit]
Description=$description
After=network-online.target redis-server.service
Wants=network-online.target

[Service]
Type=simple
User=$USER_NAME
Group=$GROUP_NAME
WorkingDirectory=$PROJECT_DIR
ExecStart=$NODE_BIN $PROJECT_DIR/$entry_script
Restart=always
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
UNIT

  echo "Wrote $unit_path"
}

write_unit "aibot" "bot.js" "aiBot Telegram bot (Node.js)"
write_unit "aibot-agent-worker" "agent_worker.js" "aiBot Agent Worker (BullMQ)"
write_unit "aibot-stt-worker" "stt_worker.js" "aiBot STT Worker (BullMQ)"
write_unit "aibot-notify-worker" "notify_worker.js" "aiBot Notify Worker (BullMQ)"

sudo systemctl daemon-reload
sudo systemctl enable --now aibot.service aibot-agent-worker.service aibot-stt-worker.service aibot-notify-worker.service

sudo systemctl --no-pager --full status aibot.service | sed -n '1,12p'
sudo systemctl --no-pager --full status aibot-agent-worker.service | sed -n '1,12p'
sudo systemctl --no-pager --full status aibot-stt-worker.service | sed -n '1,12p'
sudo systemctl --no-pager --full status aibot-notify-worker.service | sed -n '1,12p'

echo "Installed and started: aibot + workers"
