#!/usr/bin/env bash
set -euo pipefail

SERVICE_LABEL="com.pavels.telegram.bot"
PLIST_PATH="$HOME/Library/LaunchAgents/$SERVICE_LABEL.plist"
UID_NUM="$(id -u)"

launchctl bootout "gui/$UID_NUM/$SERVICE_LABEL" >/dev/null 2>&1 || true
launchctl bootout "user/$UID_NUM/$SERVICE_LABEL" >/dev/null 2>&1 || true
launchctl disable "gui/$UID_NUM/$SERVICE_LABEL" >/dev/null 2>&1 || true
launchctl disable "user/$UID_NUM/$SERVICE_LABEL" >/dev/null 2>&1 || true
rm -f "$PLIST_PATH"

echo "Service removed: $SERVICE_LABEL"
