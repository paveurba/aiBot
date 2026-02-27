#!/usr/bin/env bash
set -euo pipefail

SERVICE_LABEL="com.pavels.telegram.bot"
UID_NUM="$(id -u)"
if launchctl print "gui/$UID_NUM/$SERVICE_LABEL" >/dev/null 2>&1; then
  launchctl print "gui/$UID_NUM/$SERVICE_LABEL" | rg -n "pid =|state =|last exit code =|path =|program ="
else
  launchctl print "user/$UID_NUM/$SERVICE_LABEL" | rg -n "pid =|state =|last exit code =|path =|program ="
fi
