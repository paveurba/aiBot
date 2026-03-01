#!/usr/bin/env bash
set -euo pipefail

ENV_FILE="/home/pi/aiBot/.env"
if [[ ! -f "$ENV_FILE" ]]; then
  echo "Missing $ENV_FILE" >&2
  exit 1
fi

# Load TELEGRAM_BOT_TOKEN and TELEGRAM_ALLOWLIST
set -a
source "$ENV_FILE"
set +a

CHAT_ID="${TELEGRAM_ALLOWLIST%%,*}"
if [[ -z "${TELEGRAM_BOT_TOKEN:-}" || -z "${CHAT_ID:-}" ]]; then
  echo "Missing TELEGRAM_BOT_TOKEN or TELEGRAM_ALLOWLIST in .env" >&2
  exit 1
fi

curl -fsS -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
  -d "chat_id=${CHAT_ID}" \
  --data-urlencode "text=hello world" \
  >/dev/null
