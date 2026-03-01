#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <audio_file> [lang]" >&2
  exit 1
fi

INPUT_FILE="$1"
LANG_CODE="${2:-${WHISPER_LANG:-auto}}"
WHISPER_BIN="${WHISPER_BIN:-/home/pi/tools/whisper.cpp/build/bin/whisper-cli}"
WHISPER_MODEL="${WHISPER_MODEL:-/home/pi/tools/whisper.cpp/models/ggml-base.bin}"
THREADS="${WHISPER_THREADS:-$(nproc)}"

if [[ ! -f "$INPUT_FILE" ]]; then
  echo "Audio file not found: $INPUT_FILE" >&2
  exit 1
fi
if [[ ! -x "$WHISPER_BIN" ]]; then
  echo "whisper-cli not found: $WHISPER_BIN" >&2
  exit 1
fi
if [[ ! -f "$WHISPER_MODEL" ]]; then
  echo "Whisper model not found: $WHISPER_MODEL" >&2
  exit 1
fi

TMP_DIR="/tmp/ai-bot-stt"
mkdir -p "$TMP_DIR"
BASE_NAME="$(basename "$INPUT_FILE")"
WAV_FILE="$TMP_DIR/${BASE_NAME%.*}-$$.wav"
OUT_PREFIX="$TMP_DIR/${BASE_NAME%.*}-$$"

cleanup() {
  rm -f "$WAV_FILE" "${OUT_PREFIX}.txt" "${OUT_PREFIX}.srt" "${OUT_PREFIX}.vtt" "${OUT_PREFIX}.csv" 2>/dev/null || true
}
trap cleanup EXIT

# Convert Telegram audio (ogg/oga/mp3/...) to whisper-friendly PCM wav.
ffmpeg -y -i "$INPUT_FILE" -ar 16000 -ac 1 -c:a pcm_s16le "$WAV_FILE" -loglevel error

"$WHISPER_BIN" \
  -m "$WHISPER_MODEL" \
  -f "$WAV_FILE" \
  -l "$LANG_CODE" \
  -t "$THREADS" \
  -nt \
  -otxt \
  -of "$OUT_PREFIX" \
  >/dev/null 2>&1

if [[ ! -s "${OUT_PREFIX}.txt" ]]; then
  echo "Transcription failed: empty result" >&2
  exit 1
fi

sed -e 's/\r//g' -e '/^[[:space:]]*$/d' "${OUT_PREFIX}.txt" | paste -sd' ' -
echo
