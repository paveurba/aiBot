#!/usr/bin/env bash
set -euo pipefail

SERVICE_LABEL="com.pavels.telegram.bot"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PLIST_PATH="$HOME/Library/LaunchAgents/$SERVICE_LABEL.plist"
LOG_DIR="$PROJECT_DIR/logs"
OUT_LOG="$LOG_DIR/bot.out.log"
ERR_LOG="$LOG_DIR/bot.err.log"
NODE_BIN="${NODE_BIN:-$(command -v node)}"
DOMAIN_GUI="gui/$(id -u)"
DOMAIN_USER="user/$(id -u)"

if [[ -z "${NODE_BIN:-}" ]]; then
  echo "node binary not found in PATH"
  exit 1
fi

mkdir -p "$HOME/Library/LaunchAgents" "$LOG_DIR"

cat >"$PLIST_PATH" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$SERVICE_LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_BIN</string>
    <string>$PROJECT_DIR/bot.js</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$PROJECT_DIR</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>$OUT_LOG</string>
  <key>StandardErrorPath</key>
  <string>$ERR_LOG</string>
</dict>
</plist>
EOF

plutil -lint "$PLIST_PATH" >/dev/null

launchctl bootout "gui/$(id -u)/$SERVICE_LABEL" >/dev/null 2>&1 || true
launchctl bootout "user/$(id -u)/$SERVICE_LABEL" >/dev/null 2>&1 || true

if launchctl bootstrap "$DOMAIN_GUI" "$PLIST_PATH" >/dev/null 2>&1; then
  DOMAIN="$DOMAIN_GUI"
else
  launchctl bootstrap "$DOMAIN_USER" "$PLIST_PATH"
  DOMAIN="$DOMAIN_USER"
fi

launchctl enable "$DOMAIN/$SERVICE_LABEL" >/dev/null 2>&1 || true
launchctl kickstart -k "$DOMAIN/$SERVICE_LABEL"

echo "Service installed and started: $SERVICE_LABEL"
echo "domain: $DOMAIN"
echo "plist: $PLIST_PATH"
echo "logs:"
echo "  $OUT_LOG"
echo "  $ERR_LOG"
