#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="/home/pi/aiBot/.env"
TTS_SCRIPT="$SCRIPT_DIR/tts_to_telegram_voice.sh"
SEND_SCRIPT="$SCRIPT_DIR/send_voice.js"
TMP_FILE="/tmp/telegram_voice_$$.ogg"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Missing $ENV_FILE" >&2
  exit 1
fi

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 \"message text\" [chat_id] [lang]" >&2
  exit 1
fi

MESSAGE="$1"

set -a
source "$ENV_FILE"
set +a

CHAT_ID="${2:-${TELEGRAM_ALLOWLIST%%,*}}"
LANG_CODE="${3:-${TTS_LANG:-en}}"
if [[ -z "${TELEGRAM_BOT_TOKEN:-}" || -z "${CHAT_ID:-}" ]]; then
  echo "Missing TELEGRAM_BOT_TOKEN or chat_id" >&2
  exit 1
fi

if [[ ! -x "$TTS_SCRIPT" ]]; then
  echo "Missing TTS script: $TTS_SCRIPT" >&2
  exit 1
fi

if [[ ! -f "$SEND_SCRIPT" ]]; then
  echo "Missing voice send script: $SEND_SCRIPT" >&2
  exit 1
fi

"$TTS_SCRIPT" --text "$MESSAGE" --output "$TMP_FILE" --lang "$LANG_CODE" >/dev/null

node "$SEND_SCRIPT" --file "$TMP_FILE" --chat-id "$CHAT_ID"

rm -f "$TMP_FILE"
