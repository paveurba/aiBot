#!/usr/bin/env bash
set -euo pipefail

BASE_LABEL="com.pavels.aibot"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
LAUNCH_AGENTS_DIR="$HOME/Library/LaunchAgents"
LOG_DIR="$PROJECT_DIR/logs"
NODE_BIN="${NODE_BIN:-$(command -v node || true)}"
UID_NUM="$(id -u)"
DOMAIN_GUI="gui/$UID_NUM"
DOMAIN_USER="user/$UID_NUM"

if [[ -z "${NODE_BIN:-}" ]]; then
  echo "node binary not found in PATH"
  exit 1
fi

mkdir -p "$LAUNCH_AGENTS_DIR" "$LOG_DIR"

bootout_label() {
  local label="$1"
  launchctl bootout "$DOMAIN_GUI/$label" >/dev/null 2>&1 || true
  launchctl bootout "$DOMAIN_USER/$label" >/dev/null 2>&1 || true
}

install_one() {
  local label="$1"
  local entry_script="$2"
  local out_log="$3"
  local err_log="$4"
  local plist_path="$LAUNCH_AGENTS_DIR/$label.plist"
  local domain=""

  cat >"$plist_path" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$label</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_BIN</string>
    <string>$PROJECT_DIR/$entry_script</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$PROJECT_DIR</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>$out_log</string>
  <key>StandardErrorPath</key>
  <string>$err_log</string>
</dict>
</plist>
PLIST

  plutil -lint "$plist_path" >/dev/null
  bootout_label "$label"

  if launchctl bootstrap "$DOMAIN_GUI" "$plist_path" >/dev/null 2>&1; then
    domain="$DOMAIN_GUI"
  else
    launchctl bootstrap "$DOMAIN_USER" "$plist_path"
    domain="$DOMAIN_USER"
  fi

  launchctl enable "$domain/$label" >/dev/null 2>&1 || true
  launchctl kickstart -k "$domain/$label"

  echo "Installed: $label"
  echo "  domain: $domain"
  echo "  plist:  $plist_path"
  echo "  out:    $out_log"
  echo "  err:    $err_log"
}

install_one "$BASE_LABEL.bot" "bot.js" "$LOG_DIR/bot.out.log" "$LOG_DIR/bot.err.log"
install_one "$BASE_LABEL.worker.agent" "agent_worker.js" "$LOG_DIR/agent-worker.out.log" "$LOG_DIR/agent-worker.err.log"
install_one "$BASE_LABEL.worker.stt" "stt_worker.js" "$LOG_DIR/stt-worker.out.log" "$LOG_DIR/stt-worker.err.log"
install_one "$BASE_LABEL.worker.notify" "notify_worker.js" "$LOG_DIR/notify-worker.out.log" "$LOG_DIR/notify-worker.err.log"

echo "All aiBot services installed and started."
