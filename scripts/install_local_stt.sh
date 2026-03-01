#!/usr/bin/env bash
set -euo pipefail

TOOLS_DIR="${TOOLS_DIR:-/home/pi/tools}"
WHISPER_DIR="${WHISPER_DIR:-$TOOLS_DIR/whisper.cpp}"
WHISPER_MODEL="${WHISPER_MODEL:-base}"

sudo apt-get update -y
sudo apt-get install -y ffmpeg build-essential cmake git

mkdir -p "$TOOLS_DIR"
if [[ ! -d "$WHISPER_DIR/.git" ]]; then
  git clone --depth 1 https://github.com/ggml-org/whisper.cpp "$WHISPER_DIR"
fi

cd "$WHISPER_DIR"
cmake -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build -j"$(nproc)"

./models/download-ggml-model.sh "$WHISPER_MODEL"

echo "Installed local STT:"
echo "  whisper-cli: $WHISPER_DIR/build/bin/whisper-cli"
echo "  model:       $WHISPER_DIR/models/ggml-${WHISPER_MODEL}.bin"
