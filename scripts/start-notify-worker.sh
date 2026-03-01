#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
LOG_DIR="$PROJECT_DIR/logs"
mkdir -p "$LOG_DIR"

WORKER_NAME="${WORKER_NAME:-notify-worker}"
OUT_LOG="$LOG_DIR/${WORKER_NAME}.out.log"
ERR_LOG="$LOG_DIR/${WORKER_NAME}.err.log"

cd "$PROJECT_DIR"
nohup /usr/bin/node "$PROJECT_DIR/notify_worker.js" >>"$OUT_LOG" 2>>"$ERR_LOG" &
PID=$!

echo "Started $WORKER_NAME pid=$PID"
echo "out: $OUT_LOG"
echo "err: $ERR_LOG"
