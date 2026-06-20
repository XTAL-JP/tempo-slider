#!/bin/bash
# TEMPO Slider - AMO ソースコード提出用 ZIP 作成
# git archive を使うので .gitignore が尊重され dist/ や .claude/ 等は自動除外される

set -e

cd "$(dirname "$0")/.."

VERSION=$(grep '"version"' src/manifest.json | head -1 | sed 's/[^0-9.]//g')
OUT_DIR="dist"
OUT_FILE="$OUT_DIR/tempo-slider-source-${VERSION}.zip"

mkdir -p "$OUT_DIR"
rm -f "$OUT_FILE"

git archive --format=zip --output="$OUT_FILE" HEAD

echo ""
echo "✅ Created: $OUT_FILE"
echo "   Size: $(du -h "$OUT_FILE" | cut -f1)"
