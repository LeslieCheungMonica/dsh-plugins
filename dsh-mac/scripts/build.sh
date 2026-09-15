#!/usr/bin/env bash
#
# Build DSH Web.app and DSH-Web-<version>.dmg.
#
# Steps: icon → universal compile → .app bundle → ad-hoc codesign → compressed
# DMG carrying an /Applications alias, which is what makes the image
# drag-to-install.
#
# Objective-C, not Swift, on purpose: this machine's Command Line Tools ship a
# Swift compiler that refuses the installed SDK's module interfaces, while
# clang builds the same AppKit + WebKit code in about a second.
#
# Usage:
#   scripts/build.sh              # app + dmg into dist/
#   scripts/build.sh --app-only   # skip the DMG
#   ARCHS="arm64" scripts/build.sh
#
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VERSION="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$ROOT/Resources/Info.plist")"
APP_NAME="DSH Web"
EXECUTABLE="DSHWeb"
DIST="$ROOT/dist"
APP="$DIST/$APP_NAME.app"
BUILD="$ROOT/build"
ARCHS="${ARCHS:-arm64 x86_64}"
APP_ONLY=0
[ "${1:-}" = "--app-only" ] && APP_ONLY=1

step() { printf '\n\033[1;34m==>\033[0m %s\n' "$1"; }

step "Icon"
rm -rf "$BUILD/AppIcon.iconset"
mkdir -p "$BUILD"
clang -fobjc-arc -O2 -framework Cocoa -o "$BUILD/make-icon" "$ROOT/scripts/make-icon.m"
"$BUILD/make-icon" "$BUILD/AppIcon.iconset"
rm -f "$BUILD/AppIcon.icns"
iconutil -c icns "$BUILD/AppIcon.iconset" -o "$BUILD/AppIcon.icns"

step "Compile ($ARCHS)"
# clang takes one -arch per slice and produces a universal binary directly; a
# slice the SDK cannot build falls back to the native arch.
ARCH_FLAGS=()
for arch in $ARCHS; do ARCH_FLAGS+=(-arch "$arch"); done
mkdir -p "$BUILD/bin"
if ! clang -fobjc-arc -O2 -mmacosx-version-min=13.0 \
    "${ARCH_FLAGS[@]}" \
    -framework Cocoa -framework WebKit \
    -o "$BUILD/bin/$EXECUTABLE" \
    "$ROOT"/Sources/*.m 2>"$BUILD/compile.log"; then
  printf 'universal build failed, retrying native-arch only (see %s)\n' "$BUILD/compile.log"
  NATIVE="$(uname -m)"
  clang -fobjc-arc -O2 -mmacosx-version-min=13.0 -arch "$NATIVE" \
    -framework Cocoa -framework WebKit \
    -o "$BUILD/bin/$EXECUTABLE" "$ROOT"/Sources/*.m
fi
lipo -info "$BUILD/bin/$EXECUTABLE"

step "Bundle"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BUILD/bin/$EXECUTABLE" "$APP/Contents/MacOS/$EXECUTABLE"
cp "$ROOT/Resources/Info.plist" "$APP/Contents/Info.plist"
cp "$BUILD/AppIcon.icns" "$APP/Contents/Resources/AppIcon.icns"
printf 'APPL????' > "$APP/Contents/PkgInfo"
chmod +x "$APP/Contents/MacOS/$EXECUTABLE"

step "Sign (ad-hoc)"
# Ad-hoc keeps the bundle internally consistent. Without a Developer ID the
# first launch still needs the operator's explicit approval (see README).
codesign --force --deep --sign - --timestamp=none "$APP" >/dev/null
codesign --verify --verbose=1 "$APP" 2>&1 | tail -2

if [ "$APP_ONLY" = "1" ]; then
  step "Done (app only): $APP"
  exit 0
fi

step "DMG"
DMG="$DIST/DSH-Web-$VERSION.dmg"
STAGE="$BUILD/dmg"
rm -rf "$STAGE" "$DMG"
mkdir -p "$STAGE"
cp -R "$APP" "$STAGE/"
ln -s /Applications "$STAGE/Applications"
hdiutil create \
  -volname "$APP_NAME" \
  -srcfolder "$STAGE" \
  -fs HFS+ \
  -format UDZO \
  -ov \
  "$DMG" >/dev/null

step "Done"
printf 'app: %s\n' "$APP"
printf 'dmg: %s (%s)\n' "$DMG" "$(du -h "$DMG" | cut -f1)"
printf '\n安装：打开 DMG，把 “%s” 拖进 Applications。\n' "$APP_NAME"
printf '首次打开（未签名构建）：右键点 App → 打开；或执行：\n'
printf '  xattr -dr com.apple.quarantine "/Applications/%s.app"\n' "$APP_NAME"
