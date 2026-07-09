#!/usr/bin/env bash
# 生成 OpenTrad 应用图标（可重复执行）。
# 源：scripts/opentrad-icon.svg → apps/desktop/build/{icon.png, icon.icns}
# 依赖：macOS 自带 qlmanage / sips / iconutil（无需第三方图形库）。
#
# 用法：bash scripts/generate-icon.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SVG="$ROOT/scripts/opentrad-icon.svg"
BUILD="$ROOT/apps/desktop/build"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

mkdir -p "$BUILD"

# 1. SVG → 1024 PNG（qlmanage 缩略图 → sips 规整到精确 1024×1024）
qlmanage -t -s 1024 -o "$TMP" "$SVG" >/dev/null 2>&1
sips -z 1024 1024 "$TMP/$(basename "$SVG").png" --out "$BUILD/icon.png" >/dev/null

# 2. 生成 iconset 各尺寸 + retina 命名
ICS="$TMP/OpenTrad.iconset"
mkdir -p "$ICS"
for s in 16 32 128 256 512; do
  sips -z "$s" "$s" "$BUILD/icon.png" --out "$ICS/icon_${s}x${s}.png" >/dev/null
  d=$((s * 2))
  sips -z "$d" "$d" "$BUILD/icon.png" --out "$ICS/icon_${s}x${s}@2x.png" >/dev/null
done

# 3. iconset → icns
iconutil -c icns "$ICS" -o "$BUILD/icon.icns"

echo "generated: $BUILD/icon.png, $BUILD/icon.icns"
