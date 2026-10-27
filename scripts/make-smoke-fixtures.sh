#!/bin/sh
# Generates synthetic smoke-test fixtures locally (macOS `say`, ffmpeg, Pillow).
# No real person's voice or photo is used.
set -eu
cd "$(dirname "$0")/.."
OUT=fixtures/smoke
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$OUT"

say -v Carmit -o "$TMP/he.aiff" "שלום, אני רוצה לקבוע תור ליום שלישי בבוקר."
say -v Samantha -o "$TMP/en.aiff" "Can I book a haircut on Tuesday at ten?"
# Mono 16 kHz signed 16-bit PCM WAV, the format Muse Voice Transcribe accepts.
ffmpeg -loglevel error -y -i "$TMP/he.aiff" -i "$TMP/en.aiff" \
  -filter_complex "[0:a][1:a]concat=n=2:v=0:a=1[a]" -map "[a]" \
  -ac 1 -ar 16000 -c:a pcm_s16le "$OUT/he-en-booking.wav"

"${PYTHON:-python3}" -I scripts/make_product_photo.py "$OUT/product-mug.png"
