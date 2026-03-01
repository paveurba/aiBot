#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
VENV_DIR="${TTS_VENV_DIR:-/home/pi/.venvs/tts}"
LANG_CODE="${TTS_LANG:-en}"

usage() {
  cat <<'USAGE' >&2
Usage:
  tts_to_telegram_voice.sh --text "hello world" [--output /tmp/voice.ogg] [--lang en]
  tts_to_telegram_voice.sh --input /path/to/text.txt [--output /tmp/voice.ogg] [--lang en]

Output is Telegram-compatible OGG/Opus voice note (mono, 48kHz).
USAGE
}

TEXT_VALUE=""
INPUT_FILE=""
OUTPUT_FILE=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --text)
      TEXT_VALUE="${2:-}"
      shift 2
      ;;
    --input)
      INPUT_FILE="${2:-}"
      shift 2
      ;;
    --output)
      OUTPUT_FILE="${2:-}"
      shift 2
      ;;
    --lang)
      LANG_CODE="${2:-}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage
      exit 1
      ;;
  esac
done

if [[ -n "$TEXT_VALUE" && -n "$INPUT_FILE" ]]; then
  echo "Use either --text or --input, not both." >&2
  exit 1
fi

if [[ -z "$TEXT_VALUE" && -z "$INPUT_FILE" ]]; then
  echo "Missing input text. Provide --text or --input." >&2
  usage
  exit 1
fi

if [[ -n "$INPUT_FILE" ]]; then
  if [[ ! -f "$INPUT_FILE" ]]; then
    echo "Input file not found: $INPUT_FILE" >&2
    exit 1
  fi
  TEXT_VALUE="$(cat "$INPUT_FILE")"
fi

if [[ -z "${TEXT_VALUE//[$'\t\r\n ']}" ]]; then
  echo "Input text is empty." >&2
  exit 1
fi

if [[ -z "$OUTPUT_FILE" ]]; then
  OUTPUT_FILE="/tmp/telegram_voice_$(date +%s)_$$.ogg"
fi

mkdir -p "$(dirname "$OUTPUT_FILE")"

if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "ffmpeg is required but not found in PATH." >&2
  exit 1
fi

if [[ ! -x "$VENV_DIR/bin/python" ]]; then
  python3 -m venv "$VENV_DIR"
fi

if [[ ! -x "$VENV_DIR/bin/pip" ]]; then
  echo "pip missing in venv: $VENV_DIR" >&2
  exit 1
fi

if ! "$VENV_DIR/bin/python" -c "import gtts" >/dev/null 2>&1; then
  "$VENV_DIR/bin/pip" install --quiet gTTS >/dev/null
fi

TMP_MP3="/tmp/telegram_tts_${$}.mp3"
cleanup() {
  rm -f "$TMP_MP3"
}
trap cleanup EXIT

"$VENV_DIR/bin/python" - <<'PY' "$TEXT_VALUE" "$TMP_MP3" "$LANG_CODE"
from gtts import gTTS
import sys

text = sys.argv[1]
out = sys.argv[2]
lang = sys.argv[3]
gTTS(text=text, lang=lang).save(out)
PY

ffmpeg -y -i "$TMP_MP3" \
  -c:a libopus \
  -b:a 32k \
  -vbr on \
  -compression_level 10 \
  -ac 1 \
  -ar 48000 \
  "$OUTPUT_FILE" \
  -loglevel error

echo "$OUTPUT_FILE"
