#!/usr/bin/env bash
# 生成 OpenTrad 应用图标（可重复执行）。
# 源：scripts/opentrad-icon-source.png（1254px 位图母版）
# 产物：apps/desktop/build/{icon.png(1024), icon.icns}
# 依赖：macOS 自带 sips / iconutil（无第三方图形库）。
# 用法：bash scripts/generate-icon.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/scripts/opentrad-icon-source.png"
BUILD="$ROOT/apps/desktop/build"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$BUILD"

# 1. 母版 → 精确 1024×1024
sips -z 1024 1024 "$SRC" --out "$BUILD/icon.png" >/dev/null

# 2. iconset 各尺寸 + retina 命名
ICS="$TMP/OpenTrad.iconset"; mkdir -p "$ICS"
for s in 16 32 128 256 512; do
  sips -z "$s" "$s" "$BUILD/icon.png" --out "$ICS/icon_${s}x${s}.png" >/dev/null
  d=$((s * 2))
  sips -z "$d" "$d" "$BUILD/icon.png" --out "$ICS/icon_${s}x${s}@2x.png" >/dev/null
done

# 3. iconset → icns
iconutil -c icns "$ICS" -o "$BUILD/icon.icns"
echo "generated: $BUILD/icon.png, $BUILD/icon.icns"
