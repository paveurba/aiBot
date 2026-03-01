#!/usr/bin/env bash
set -euo pipefail

BASE_LABEL="com.pavels.aibot"
UID_NUM="$(id -u)"
DOMAIN_GUI="gui/$UID_NUM"
DOMAIN_USER="user/$UID_NUM"
LAUNCH_AGENTS_DIR="$HOME/Library/LaunchAgents"

remove_one() {
  local label="$1"
  local plist_path="$LAUNCH_AGENTS_DIR/$label.plist"

  launchctl bootout "$DOMAIN_GUI/$label" >/dev/null 2>&1 || true
  launchctl bootout "$DOMAIN_USER/$label" >/dev/null 2>&1 || true
  launchctl disable "$DOMAIN_GUI/$label" >/dev/null 2>&1 || true
  launchctl disable "$DOMAIN_USER/$label" >/dev/null 2>&1 || true
  rm -f "$plist_path"

  echo "Removed: $label"
}

remove_one "$BASE_LABEL.bot"
remove_one "$BASE_LABEL.worker.agent"
remove_one "$BASE_LABEL.worker.stt"
remove_one "$BASE_LABEL.worker.notify"

echo "All aiBot services removed."
