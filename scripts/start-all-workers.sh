#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

"$SCRIPT_DIR/start-agent-worker.sh"
"$SCRIPT_DIR/start-stt-worker.sh"
"$SCRIPT_DIR/start-notify-worker.sh"
