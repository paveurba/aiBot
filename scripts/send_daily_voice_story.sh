#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VOICE_SCRIPT="$SCRIPT_DIR/send_voice.sh"

if [[ ! -x "$VOICE_SCRIPT" ]]; then
  echo "Missing executable voice workflow script: $VOICE_SCRIPT" >&2
  exit 1
fi

# Optional override via env var from cron context.
MESSAGE="${VOICE_CRON_TEXT:-In a quiet forest, little Benny Bear found a glowing lantern by the river. He shared his honey bread with a lost bunny, and together they found the way home under the old oak tree.}"

echo "[$(date -u +"%Y-%m-%dT%H:%M:%SZ")] voice_cron_start"
"$VOICE_SCRIPT" "$MESSAGE"
echo "[$(date -u +"%Y-%m-%dT%H:%M:%SZ")] voice_cron_done"
