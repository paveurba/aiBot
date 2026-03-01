#!/usr/bin/env bash
set -euo pipefail

BASE_LABEL="com.pavels.aibot"
UID_NUM="$(id -u)"
DOMAIN_GUI="gui/$UID_NUM"
DOMAIN_USER="user/$UID_NUM"

print_status_one() {
  local label="$1"
  local domain_path=""

  if launchctl print "$DOMAIN_GUI/$label" >/dev/null 2>&1; then
    domain_path="$DOMAIN_GUI/$label"
  elif launchctl print "$DOMAIN_USER/$label" >/dev/null 2>&1; then
    domain_path="$DOMAIN_USER/$label"
  else
    echo "[$label] not loaded"
    return
  fi

  echo "[$label]"
  launchctl print "$domain_path" | egrep -n "pid =|state =|last exit code =|path =|program =" || true
  echo
}

print_status_one "$BASE_LABEL.bot"
print_status_one "$BASE_LABEL.worker.agent"
print_status_one "$BASE_LABEL.worker.stt"
print_status_one "$BASE_LABEL.worker.notify"
